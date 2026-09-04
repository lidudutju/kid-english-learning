import { Hono } from "hono";
import {
  partCount as partCountFor,
  titleFromFilename,
  uploadCompleteRequest,
  uploadExtension,
  uploadPrepareRequest,
  uploadSourceKey,
  UPLOAD_EXTENSIONS,
  UPLOAD_PART_BYTES,
} from "@kel/shared";
import type { AppBindings } from "../env.js";
import { originalKey, randomId } from "../db.js";

export const uploadRoutes = new Hono<AppBindings>();

interface ReceivingJob {
  original_key: string | null;
  upload_id: string | null;
  source_bytes: number | null;
}

/**
 * Fetch a job that is still receiving bytes, and mark it as alive in the same round trip.
 *
 * The touch matters: an abandoned `receiving` job is swept away by the nightly job, and a slow
 * upload over a home connection must not look abandoned while it is still going.
 */
function claimReceiving(
  db: D1Database,
  jobId: string,
  now: number,
): Promise<ReceivingJob | null> {
  return db
    .prepare(
      `UPDATE ingest_jobs SET updated_at = ?2
        WHERE id = ?1 AND status = 'receiving'
        RETURNING original_key, upload_id, source_bytes`,
    )
    .bind(jobId, now)
    .first<ReceivingJob>();
}

/**
 * Announce a file, get somewhere to put it.
 *
 * The Duplicate check happens here, before any bytes move, which is the entire reason the
 * browser hashes the file first — the alternative is discovering the video is already in the
 * library after twenty minutes of uploading (docs/adr/0004).
 */
uploadRoutes.post("/", async (c) => {
  const parsed = uploadPrepareRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "请求格式不对（文件可能太大）" }, 400);
  const { sourceDigest, filename, bytes } = parsed.data;

  if (!uploadExtension(filename)) {
    return c.json({ error: `只收这些格式：${UPLOAD_EXTENSIONS.join("、")}` }, 400);
  }

  const sourceKey = uploadSourceKey(sourceDigest);

  const existing = await c.env.DB.prepare(
    `SELECT id, title FROM videos WHERE source_key = ?1 OR source_digest = ?2`,
  )
    .bind(sourceKey, sourceDigest)
    .first<{ id: string; title: string }>();

  if (existing) {
    return c.json(
      { error: `库里已经有一模一样的内容了：${existing.title}`, duplicateOf: existing.id },
      409,
    );
  }

  // A live job for the same file is either the same upload being retried after a dropped
  // connection — in which case its half-written parts are worthless and it goes — or work
  // already under way, which is not something to duplicate.
  const live = await c.env.DB.prepare(
    `SELECT id, status, original_key, upload_id FROM ingest_jobs
      WHERE source_key = ?1 AND status NOT IN ('done', 'failed')`,
  )
    .bind(sourceKey)
    .first<{ id: string; status: string; original_key: string | null; upload_id: string | null }>();

  if (live && live.status !== "receiving") {
    return c.json({ error: "这个文件已经在队列里了" }, 409);
  }
  if (live) {
    await abandon(c.env.PRIVATE, live.original_key, live.upload_id);
    await c.env.DB.prepare(`DELETE FROM ingest_jobs WHERE id = ?1`).bind(live.id).run();
  }

  const now = Date.now();
  const jobId = crypto.randomUUID();
  const key = originalKey(jobId);
  const title = parsed.data.title?.trim() || titleFromFilename(filename);

  const multipart = await c.env.PRIVATE.createMultipartUpload(key);

  try {
    await c.env.DB.prepare(
      `INSERT INTO ingest_jobs
         (id, source_kind, source_key, source_url, asset_prefix, title, status, attempts,
          source_digest, original_key, upload_id, source_bytes, created_at, updated_at)
       VALUES (?1, 'upload', ?2, NULL, ?3, ?4, 'receiving', 0, ?5, ?6, ?7, ?8, ?9, ?9)`,
    )
      .bind(
        jobId,
        sourceKey,
        `v/${randomId()}`,
        title,
        sourceDigest,
        key,
        multipart.uploadId,
        bytes,
        now,
      )
      .run();
  } catch (err) {
    await abandon(c.env.PRIVATE, key, multipart.uploadId);
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return c.json({ error: "这个文件已经在队列里了" }, 409);
    }
    throw err;
  }

  return c.json(
    { jobId, partBytes: UPLOAD_PART_BYTES, partCount: partCountFor(bytes) },
    201,
  );
});

/**
 * One part, relayed into R2.
 *
 * The bytes pass through the Worker instead of going straight to R2 because a presigned URL
 * would mean putting S3 credentials in the Worker, and R2's bucket binding cannot sign one.
 * A part is small enough that this costs no meaningful CPU — it is a copy, not a computation.
 */
uploadRoutes.put("/:jobId/parts/:partNumber", async (c) => {
  const partNumber = Number(c.req.param("partNumber"));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    return c.json({ error: "part 编号不对" }, 400);
  }

  const job = await claimReceiving(c.env.DB, c.req.param("jobId"), Date.now());
  if (!job?.original_key || !job.upload_id) {
    return c.json({ error: "这个上传已经结束或被取消了" }, 409);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: "part 是空的" }, 400);

  const multipart = c.env.PRIVATE.resumeMultipartUpload(job.original_key, job.upload_id);
  const uploaded = await multipart.uploadPart(partNumber, body);

  return c.json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
});

/** All parts are in: stitch them together and hand the job to the queue. */
uploadRoutes.post("/:jobId/complete", async (c) => {
  const parsed = uploadCompleteRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "请求格式不对" }, 400);

  const jobId = c.req.param("jobId");
  const now = Date.now();
  const job = await claimReceiving(c.env.DB, jobId, now);
  if (!job?.original_key || !job.upload_id) {
    return c.json({ error: "这个上传已经结束或被取消了" }, 409);
  }

  const multipart = c.env.PRIVATE.resumeMultipartUpload(job.original_key, job.upload_id);
  const object = await multipart.complete(
    [...parsed.data.parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
  );

  // The digest was computed over the file the parent picked; if what landed is a different
  // length it is not that file, and letting the Agent hash it later would only find out
  // slower. Reject now, keep nothing.
  if (job.source_bytes !== null && object.size !== job.source_bytes) {
    c.executionCtx.waitUntil(c.env.PRIVATE.delete(job.original_key));
    await c.env.DB.prepare(`DELETE FROM ingest_jobs WHERE id = ?1`).bind(jobId).run();
    return c.json({ error: "上传的大小和登记的不一致，请重新试一次" }, 409);
  }

  await c.env.DB.prepare(
    `UPDATE ingest_jobs
        SET status = 'queued', upload_id = NULL, updated_at = ?2
      WHERE id = ?1 AND status = 'receiving'`,
  )
    .bind(jobId, now)
    .run();

  return c.json({ ok: true });
});

/** The browser gave up, or the parent changed their mind. Leave nothing behind. */
uploadRoutes.delete("/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = await claimReceiving(c.env.DB, jobId, Date.now());
  if (!job) return c.json({ ok: true });

  await abandon(c.env.PRIVATE, job.original_key, job.upload_id);
  await c.env.DB.prepare(`DELETE FROM ingest_jobs WHERE id = ?1 AND status = 'receiving'`)
    .bind(jobId)
    .run();

  return c.json({ ok: true });
});

/**
 * Throw away a partly-arrived upload.
 *
 * Aborting is what actually frees the parts already in R2 — deleting the key does not, because
 * an incomplete multipart upload has no object at that key yet. Failures are swallowed: this is
 * always called while cleaning up after something that has already gone wrong.
 */
export async function abandon(
  bucket: R2Bucket,
  key: string | null,
  uploadId: string | null,
): Promise<void> {
  if (!key) return;
  if (uploadId) {
    await bucket.resumeMultipartUpload(key, uploadId).abort().catch(() => {});
  }
  await bucket.delete(key).catch(() => {});
}
