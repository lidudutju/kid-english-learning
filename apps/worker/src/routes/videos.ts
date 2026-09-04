import { Hono } from "hono";
import {
  addYoutubeRequest,
  parseYoutubeInput,
  YOUTUBE_PARSE_MESSAGE,
  MAX_ATTEMPTS,
} from "@kel/shared";
import type { AppBindings } from "../env.js";
import { randomId, type VideoRow } from "../db.js";

export const videoRoutes = new Hono<AppBindings>();
export const jobRoutes = new Hono<AppBindings>();

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** Queue a YouTube link. Both Duplicate blocks are checked here and again by the DB. */
videoRoutes.post("/youtube", async (c) => {
  const parsed = addYoutubeRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "请求格式不对" }, 400);

  const link = parseYoutubeInput(parsed.data.url);
  if (!link.ok) return c.json({ error: YOUTUBE_PARSE_MESSAGE[link.reason] }, 400);

  const existing = await c.env.DB.prepare(
    `SELECT id, title FROM videos WHERE source_key = ?1`,
  )
    .bind(link.sourceKey)
    .first<{ id: string; title: string }>();

  if (existing) {
    return c.json(
      { error: `这个视频已经在库里了：${existing.title}`, duplicateOf: existing.id },
      409,
    );
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  // Assigned now, not by the Agent, so a retry overwrites instead of orphaning bytes.
  const assetPrefix = `v/${randomId()}`;

  try {
    await c.env.DB.prepare(
      `INSERT INTO ingest_jobs
         (id, source_kind, source_key, source_url, asset_prefix, status, attempts, created_at, updated_at)
       VALUES (?1, 'youtube', ?2, ?3, ?4, 'queued', 0, ?5, ?5)`,
    )
      .bind(id, link.sourceKey, link.canonicalUrl, assetPrefix, now)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: "这个视频已经在队列里了" }, 409);
    }
    throw err;
  }

  return c.json({ jobId: id, sourceKey: link.sourceKey }, 201);
});

/**
 * Removal: the Video, its bytes, its Progress, its Watches and its place in the Duplicate
 * check all go. No archive, no undo.
 *
 * D1 first, R2 second. If the second step fails we are left with unreferenced bytes in R2,
 * which are invisible and cost pennies; the other order would leave a Video in the library
 * whose Playable 404s, which looks like data loss to the person using it.
 */
videoRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT playable_key, thumb_key FROM videos WHERE id = ?1`,
  )
    .bind(id)
    .first<Pick<VideoRow, "playable_key" | "thumb_key">>();

  if (!row) return c.json({ error: "找不到这个视频" }, 404);

  // The history goes with it. Leaving Progress behind would resurrect a stage and a review
  // schedule if the same Source were ever added again — CONTEXT.md is explicit that the
  // identity goes too.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM videos WHERE id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM progress WHERE video_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM watches WHERE video_id = ?1`).bind(id),
    // The Transcript and its Focus Words are about this Video and nothing else. Leaving it
    // behind would also keep the Video findable by its own lyrics through transcript search.
    c.env.DB.prepare(`DELETE FROM transcripts WHERE video_id = ?1`).bind(id),
  ]);

  const keys = [row.playable_key, row.thumb_key].filter((k): k is string => Boolean(k));
  c.executionCtx.waitUntil(c.env.MEDIA.delete(keys));

  return c.json({ ok: true });
});

/** Re-queue a failed job. The live-source unique index still applies. */
jobRoutes.post("/:id/retry", async (c) => {
  const id = c.req.param("id");
  const job = await c.env.DB.prepare(
    `SELECT status, attempts, source_kind, original_key FROM ingest_jobs WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      status: string;
      attempts: number;
      source_kind: string;
      original_key: string | null;
    }>();

  if (!job) return c.json({ error: "找不到这个任务" }, 404);
  if (job.status !== "failed") return c.json({ error: "只有失败的任务才能重试" }, 409);

  // A YouTube link can always be fetched again. An upload's original is deleted the moment the
  // job finally fails, so there is nothing left to retry from — re-picking the file is the
  // honest version of "try again", and it is one tap.
  if (job.source_kind === "upload" && !job.original_key) {
    return c.json({ error: "原片已经不在了，重新选一次文件吧" }, 409);
  }

  try {
    await c.env.DB.prepare(
      `UPDATE ingest_jobs
          SET status = 'queued', error = NULL, detail = NULL, stage_percent = NULL,
              agent_id = NULL, lease_expires_at = NULL,
              -- Someone tapped 重试; that means now, not after the automatic backoff.
              next_attempt_at = NULL,
              attempts = CASE WHEN attempts >= ?2 THEN 0 ELSE attempts END,
              updated_at = ?3
        WHERE id = ?1`,
    )
      .bind(id, MAX_ATTEMPTS, Date.now())
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: "这个来源已经有一个进行中的任务了" }, 409);
    }
    throw err;
  }

  return c.json({ ok: true });
});

/** Dismiss a job from the list. Only meaningful for terminal jobs. */
jobRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const res = await c.env.DB.prepare(
    `DELETE FROM ingest_jobs WHERE id = ?1 AND status IN ('failed', 'done')`,
  )
    .bind(id)
    .run();

  if (!res.meta.changes) return c.json({ error: "进行中的任务不能删除" }, 409);
  return c.json({ ok: true });
});
