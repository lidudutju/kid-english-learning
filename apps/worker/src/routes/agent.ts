import { Hono } from "hono";
import {
  agentClaimRequest,
  agentCompleteRequest,
  agentFailRequest,
  agentProgressRequest,
  LEASE_SECONDS,
  LEASED_STATUSES,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  type AgentClaim,
} from "@kel/shared";
import type { AppBindings } from "../env.js";
import { playableKey, rowsOf, thumbKey } from "../db.js";

export const agentRoutes = new Hono<AppBindings>();

const LEASED_SQL = LEASED_STATUSES.map((s) => `'${s}'`).join(", ");

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/**
 * Token and connectivity check that claims nothing.
 *
 * `pnpm doctor` needs to prove the Agent can reach and authenticate against the Worker, and
 * using /claim for that would silently pull a real job out of the queue and drop it.
 */
agentRoutes.get("/ping", (c) => c.json({ ok: true, now: Date.now() }));

/**
 * Hand out at most one job, atomically.
 *
 * The whole thing is one D1 batch, so it is one transaction: two Agents polling at the same
 * instant cannot both walk away with the same job, which matters because a second machine is
 * expected later.
 */
agentRoutes.post("/claim", async (c) => {
  const parsed = agentClaimRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad request" }, 400);
  const { agentId, hostname } = parsed.data;

  const now = Date.now();
  const leaseExpiresAt = now + LEASE_SECONDS * 1000;

  const batch = await c.env.DB.batch<Record<string, unknown>>([
    // Who is alive. Drives the "the machine at home is offline" line in the UI.
    c.env.DB.prepare(
      `INSERT INTO agents (id, hostname, last_seen_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = ?3, hostname = ?2`,
    ).bind(agentId, hostname ?? null, now),

    // Reap: a job whose Agent died and has already burned its attempts must not be handed
    // out forever. Without this it would be reclaimed on every poll until the end of time.
    c.env.DB.prepare(
      `UPDATE ingest_jobs
          SET status = 'failed',
              error = '多次尝试都没成功，家里的机器可能中途断了',
              agent_id = NULL, lease_expires_at = NULL, updated_at = ?1
        WHERE status IN (${LEASED_SQL}) AND lease_expires_at < ?1 AND attempts >= ?2`,
    ).bind(now, MAX_ATTEMPTS),

    c.env.DB.prepare(
      `UPDATE ingest_jobs
          SET status = 'claimed', agent_id = ?1, lease_expires_at = ?2,
              attempts = attempts + 1, stage_percent = NULL, detail = NULL,
              next_attempt_at = NULL, updated_at = ?3
        WHERE id = (
                SELECT id FROM ingest_jobs
                 WHERE attempts < ?4
                   AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)
                   AND (status = 'queued'
                        OR (status IN (${LEASED_SQL}) AND lease_expires_at < ?3))
                 ORDER BY created_at
                 LIMIT 1
              )
        RETURNING id, source_kind, source_key, source_url, asset_prefix, attempts,
                  lease_expires_at, title, source_digest, source_bytes`,
    ).bind(agentId, leaseExpiresAt, now, MAX_ATTEMPTS),
  ]);

  const row = rowsOf<{
    id: string;
    source_kind: string;
    source_key: string;
    source_url: string | null;
    asset_prefix: string;
    attempts: number;
    lease_expires_at: number;
    title: string | null;
    source_digest: string | null;
    source_bytes: number | null;
  }>(batch, 2)[0];

  const body: AgentClaim = row
    ? {
        job: {
          id: row.id,
          sourceKind: row.source_kind as "youtube" | "upload",
          sourceKey: row.source_key,
          sourceUrl: row.source_url,
          assetPrefix: row.asset_prefix,
          attempts: row.attempts,
          leaseExpiresAt: row.lease_expires_at,
          title: row.title,
          sourceDigest: row.source_digest,
          sourceBytes: row.source_bytes,
        },
      }
    : { job: null };

  return c.json(body);
});

/**
 * Hand an uploaded original to the Agent.
 *
 * It comes through the Worker rather than out of R2 directly so that the Agent's R2 credentials
 * can stay scoped to the public media bucket alone — an original is not a Playable and has no
 * business being reachable from the web (docs/adr/0004). The lease is checked, so only the Agent
 * currently holding the job can read it.
 */
agentRoutes.get("/jobs/:id/original", async (c) => {
  const agentId = c.req.query("agentId");
  if (!agentId) return c.json({ error: "bad request" }, 400);

  const job = await c.env.DB.prepare(
    `SELECT original_key FROM ingest_jobs
      WHERE id = ?1 AND agent_id = ?2 AND status IN (${LEASED_SQL})`,
  )
    .bind(c.req.param("id"), agentId)
    .first<{ original_key: string | null }>();

  if (!job) return c.json({ error: "lease-lost" }, 409);
  if (!job.original_key) return c.json({ error: "这个任务没有上传的原片" }, 404);

  const object = await c.env.PRIVATE.get(job.original_key);
  if (!object) return c.json({ error: "原片已经不在了，请重新上传" }, 404);

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(object.size),
    },
  });
});

/** Heartbeat plus progress. Extending the lease and reporting are the same act. */
agentRoutes.patch("/jobs/:id/progress", async (c) => {
  const parsed = agentProgressRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad request" }, 400);
  const { agentId, status, stagePercent, detail } = parsed.data;

  const now = Date.now();
  const res = await c.env.DB.prepare(
    `UPDATE ingest_jobs
        SET status = ?1, stage_percent = ?2, detail = ?3,
            lease_expires_at = ?4, updated_at = ?5
      WHERE id = ?6 AND agent_id = ?7 AND status IN (${LEASED_SQL})`,
  )
    .bind(status, stagePercent ?? null, detail ?? null, now + LEASE_SECONDS * 1000, now, c.req.param("id"), agentId)
    .run();

  // The lease was reclaimed by someone else while this Agent was working. Telling it so lets
  // it abandon the job instead of finishing and then losing the race at complete time.
  if (!res.meta.changes) return c.json({ error: "lease-lost" }, 409);
  return c.json({ leaseExpiresAt: now + LEASE_SECONDS * 1000 });
});

/** The Playable is already in R2; register the Video and close the job. */
agentRoutes.post("/jobs/:id/complete", async (c) => {
  const parsed = agentCompleteRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "bad request", detail: parsed.error?.issues }, 400);
  }
  const body = parsed.data;
  const jobId = c.req.param("id");

  const job = await c.env.DB.prepare(
    `SELECT source_kind, source_key, source_url, asset_prefix, title, source_digest, original_key
       FROM ingest_jobs
      WHERE id = ?1 AND agent_id = ?2 AND status IN (${LEASED_SQL})`,
  )
    .bind(jobId, body.agentId)
    .first<{
      source_kind: string;
      source_key: string;
      source_url: string | null;
      asset_prefix: string;
      title: string | null;
      source_digest: string | null;
      original_key: string | null;
    }>();

  if (!job) return c.json({ error: "lease-lost" }, 409);

  const now = Date.now();
  const videoId = crypto.randomUUID();
  const prefix = job.asset_prefix;

  /**
   * For an upload the digest was fixed by the browser before the bytes moved, and it is the
   * Video's identity. If what the Agent hashed differs, something corrupted the file in
   * transit — registering it would attach the wrong identity to real bytes, so the job dies
   * here rather than being retried into the same mismatch.
   */
  if (job.source_digest !== null && job.source_digest !== body.sourceDigest) {
    c.executionCtx.waitUntil(
      Promise.all([
        c.env.MEDIA.delete([playableKey(prefix), thumbKey(prefix)]),
        job.original_key ? c.env.PRIVATE.delete(job.original_key) : Promise.resolve(),
      ]).then(() => undefined),
    );
    await c.env.DB.prepare(
      `UPDATE ingest_jobs
          SET status = 'failed', error = ?2, attempts = ?3, agent_id = NULL,
              lease_expires_at = NULL, original_key = NULL, updated_at = ?4
        WHERE id = ?1`,
    )
      .bind(jobId, "上传的文件在传输中损坏了，请重新上传", MAX_ATTEMPTS, now)
      .run();
    return c.json({ error: "digest-mismatch" }, 409);
  }

  // The parent's own title, typed while picking the file, beats anything derived from a
  // filename by the Agent.
  const title = job.source_kind === "upload" ? (job.title ?? body.title) : body.title;

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO videos
           (id, source_kind, source_key, source_url, source_digest, asset_prefix,
            playable_key, thumb_key, title, channel, duration_seconds, width, height,
            bytes, published_at, added_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`,
      ).bind(
        videoId,
        job.source_kind,
        job.source_key,
        job.source_url,
        body.sourceDigest,
        prefix,
        playableKey(prefix),
        body.hasThumb ? thumbKey(prefix) : null,
        title,
        body.channel,
        body.durationSeconds,
        body.width,
        body.height,
        body.bytes,
        body.publishedAt,
        now,
      ),
      c.env.DB.prepare(
        `UPDATE ingest_jobs
            SET status = 'done', stage_percent = 100, detail = NULL, error = NULL,
                video_id = ?2, title = ?3, agent_id = NULL, lease_expires_at = NULL,
                original_key = NULL, updated_at = ?4
          WHERE id = ?1`,
      ).bind(jobId, videoId, title, now),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      // A Duplicate that only became visible once the bytes existed: either the same link
      // was added and finished meanwhile, or a different link produced identical bytes.
      await c.env.DB.prepare(
        `UPDATE ingest_jobs
            SET status = 'failed', error = ?2, agent_id = NULL, lease_expires_at = NULL,
                attempts = ?3, updated_at = ?4
          WHERE id = ?1`,
      )
        .bind(jobId, "库里已经有一模一样的内容了", MAX_ATTEMPTS, now)
        .run();

      c.executionCtx.waitUntil(
        c.env.MEDIA.delete([playableKey(prefix), thumbKey(prefix)]),
      );
      if (job.original_key) {
        c.executionCtx.waitUntil(c.env.PRIVATE.delete(job.original_key));
      }
      return c.json({ error: "duplicate" }, 409);
    }
    throw err;
  }

  // The Video exists and the Playable is what gets served from here on. Keeping the original
  // would double the storage for a file nothing reads.
  if (job.original_key) {
    c.executionCtx.waitUntil(c.env.PRIVATE.delete(job.original_key));
  }

  return c.json({ videoId });
});

/**
 * Report a failure. Retryable failures go back in the queue until attempts run out.
 *
 * `next_attempt_at` is what makes the retry worth having: the Agent polls every 10s, so a job
 * re-queued for "now" is picked up again immediately and all three attempts hit the same broken
 * minute. The error text is kept on the row while it waits so the UI can say why.
 */
agentRoutes.post("/jobs/:id/fail", async (c) => {
  const parsed = agentFailRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad request" }, 400);
  const { agentId, error, retryable } = parsed.data;

  const now = Date.now();
  const jobId = c.req.param("id");
  const res = await c.env.DB.prepare(
    `UPDATE ingest_jobs
        SET status = CASE WHEN ?2 = 1 AND attempts < ?3 THEN 'queued' ELSE 'failed' END,
            next_attempt_at =
              CASE WHEN ?2 = 1 AND attempts < ?3 THEN ?5 + ?7 * attempts ELSE NULL END,
            error = ?4, detail = NULL, stage_percent = NULL,
            agent_id = NULL, lease_expires_at = NULL, updated_at = ?5
      WHERE id = ?1 AND agent_id = ?6 AND status IN (${LEASED_SQL})
      RETURNING status, original_key`,
  )
    .bind(
      jobId,
      retryable ? 1 : 0,
      MAX_ATTEMPTS,
      error.slice(0, 2000),
      now,
      agentId,
      RETRY_BACKOFF_MS,
    )
    .first<{ status: string; original_key: string | null }>();

  if (!res) return c.json({ error: "lease-lost" }, 409);

  // Still going back in the queue? Then the original is exactly what the next attempt needs.
  // Finally failed? Nothing will ever read it again — and 「重试」 on an upload is not offered
  // for the same reason (the file is gone, so re-picking it is the honest retry).
  if (res.status === "failed" && res.original_key) {
    c.executionCtx.waitUntil(c.env.PRIVATE.delete(res.original_key));
    await c.env.DB.prepare(`UPDATE ingest_jobs SET original_key = NULL WHERE id = ?1`)
      .bind(jobId)
      .run();
  }

  return c.json({ ok: true });
});
