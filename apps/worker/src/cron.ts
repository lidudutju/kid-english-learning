import type { Env } from "./env.js";
import { rowsOf } from "./db.js";
import { abandon } from "./routes/uploads.js";

/**
 * How long a half-finished upload is given before it is treated as abandoned. Long enough for a
 * big file over a slow uplink with the phone locking in between; short enough that a dead
 * upload does not hold its Source Key hostage for a week.
 */
const RECEIVING_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Nightly housekeeping: export the metadata, then throw away what was abandoned.
 *
 * The export recovers titles, ids and Progress after a mistake — it does not recover the
 * Playables, because R2 has no object versioning and Removal deletes the bytes for real.
 * Deliberately a straight serialise: Cron Triggers get the same 10 ms CPU budget as requests
 * on the Free plan.
 */
export async function nightly(env: Env, scheduledTime: number): Promise<void> {
  await exportMetadata(env, scheduledTime);
  await sweepAbandonedUploads(env, scheduledTime);
}

async function exportMetadata(env: Env, scheduledTime: number): Promise<void> {
  const batch = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT * FROM videos ORDER BY added_at`),
    env.DB.prepare(`SELECT * FROM ingest_jobs WHERE status = 'failed' ORDER BY created_at`),
    env.DB.prepare(`SELECT * FROM learners ORDER BY created_at`),
    env.DB.prepare(`SELECT * FROM progress ORDER BY video_id`),
    // Watches are the only thing here that grows without bound, and they are what the counters
    // are derived from — a year of a toddler's repetitions is still a few thousand rows.
    env.DB.prepare(`SELECT * FROM watches ORDER BY counted_at`),
    /*
     * Transcripts without their `cues` or `text`.
     *
     * Not an oversight and not laziness: those two columns are the whole bulk of the table, and
     * serialising a library's worth of them would spend the entire 10 ms on the one thing in this
     * database that is fully re-derivable — the cues come from the Source, and the Focus Words
     * come from a pure function over them. What is kept is the part worth knowing after a
     * restore: which Videos had a Transcript, where it came from, and what it taught.
     */
    env.DB.prepare(
      `SELECT video_id, lang, kind, focus_words, created_at FROM transcripts ORDER BY video_id`,
    ),
  ]);

  const day = new Date(scheduledTime).toISOString().slice(0, 10);
  const payload = {
    exportedAt: new Date(scheduledTime).toISOString(),
    schemaVersion: 3,
    videos: rowsOf(batch, 0),
    failedJobs: rowsOf(batch, 1),
    learners: rowsOf(batch, 2),
    progress: rowsOf(batch, 3),
    watches: rowsOf(batch, 4),
    transcripts: rowsOf(batch, 5),
  };

  await env.PRIVATE.put(`backups/${day}.json`, JSON.stringify(payload), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * An upload the browser started and never finished.
 *
 * Two separate leaks to close: the multipart parts already in R2 (invisible — an incomplete
 * multipart upload has no object at its key, so only `abort` frees them), and the `receiving`
 * job row, which holds that Source Key against the live-source unique index and would refuse
 * the same file if it were picked again.
 */
async function sweepAbandonedUploads(env: Env, scheduledTime: number): Promise<void> {
  const stale = await env.DB.prepare(
    `SELECT id, original_key, upload_id FROM ingest_jobs
      WHERE status = 'receiving' AND updated_at < ?1`,
  )
    .bind(scheduledTime - RECEIVING_TTL_MS)
    .all<{ id: string; original_key: string | null; upload_id: string | null }>();

  for (const job of stale.results) {
    await abandon(env.PRIVATE, job.original_key, job.upload_id);
    await env.DB.prepare(`DELETE FROM ingest_jobs WHERE id = ?1 AND status = 'receiving'`)
      .bind(job.id)
      .run();
  }

  // Originals whose job is gone or has moved on. Normally deleted the moment the Video is
  // registered; this catches the case where the Agent's lease lapsed and the job was reaped by
  // a bulk UPDATE that never saw the key.
  const listed = await env.PRIVATE.list({ prefix: "originals/", limit: 200 });
  for (const object of listed.objects) {
    const jobId = object.key.slice("originals/".length);
    const live = await env.DB.prepare(
      `SELECT 1 AS ok FROM ingest_jobs
        WHERE id = ?1 AND status NOT IN ('done', 'failed') AND original_key IS NOT NULL`,
    )
      .bind(jobId)
      .first<{ ok: number }>();
    if (!live) await env.PRIVATE.delete(object.key);
  }
}
