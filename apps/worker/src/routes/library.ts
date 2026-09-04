import { Hono } from "hono";
import { dayKey, LEASE_SECONDS, type LibraryResponse } from "@kel/shared";
import type { AppBindings } from "../env.js";
import {
  DEFAULT_LEARNER_ID,
  rowsOf,
  toJob,
  toProgress,
  toVideo,
  type JobRow,
  type ProgressRow,
  type VideoRow,
} from "../db.js";

export const libraryRoutes = new Hono<AppBindings>();

/**
 * The whole library in one response.
 *
 * There is no server-side search on purpose: at a few hundred Videos the entire manifest is
 * smaller than a single thumbnail, so the client filters in memory and every keystroke is
 * instant. The `version` lets the client skip re-parsing when nothing has changed. Today's
 * Watchlist is derived from this same payload for the same reason — no second request, and no
 * second definition of what is Due.
 */
libraryRoutes.get("/", async (c) => {
  const now = Date.now();
  const batch = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT * FROM videos ORDER BY added_at DESC`,
    ),
    // `receiving` is left out: those bytes are still in the browser that is uploading them, and
    // only that tab has anything true to say about how far along it is.
    c.env.DB.prepare(
      `SELECT * FROM ingest_jobs
         WHERE status != 'receiving' AND (status != 'done' OR updated_at > ?1)
         ORDER BY created_at DESC`,
    ).bind(now - 24 * 60 * 60 * 1000),
    c.env.DB.prepare(`SELECT MAX(last_seen_at) AS last_seen_at FROM agents`),
    c.env.DB.prepare(`SELECT * FROM progress WHERE learner_id = ?1`).bind(DEFAULT_LEARNER_ID),
  ]);

  const videoRows = rowsOf<VideoRow>(batch, 0);
  const jobRows = rowsOf<JobRow>(batch, 1);
  const progressRows = rowsOf<ProgressRow>(batch, 3);
  const videos = videoRows.map((r) => toVideo(r, c.env.MEDIA_BASE_URL));
  const jobs = jobRows.map(toJob);
  const lastSeen = rowsOf<{ last_seen_at: number | null }>(batch, 2)[0]?.last_seen_at ?? null;

  // Two missed poll intervals' worth of slack, expressed via the lease so the two notions of
  // "the machine at home is alive" cannot drift apart.
  const agentOnline = lastSeen !== null && now - lastSeen < LEASE_SECONDS * 1000;

  const body: LibraryResponse = {
    version: libraryVersion(videoRows, jobRows, progressRows),
    videos,
    jobs,
    progress: progressRows.map(toProgress),
    today: dayKey(now),
    agentOnline,
    agentLastSeenAt: lastSeen,
  };

  const etag = `W/"${body.version}"`;
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  return c.json(body);
});

/**
 * Cheap change token: row counts plus the newest timestamps. A delete changes the count, an
 * edit changes `updated_at`, and an add changes both — enough to be safe without keeping a
 * separate version counter in sync.
 *
 * Progress is in here for a reason that is easy to miss: tapping a Stage chip changes no Video
 * and no job, so without it the response would keep its old ETag, the poll would 304, and the
 * chip would spring back to where it was.
 */
function libraryVersion(
  videos: VideoRow[],
  jobs: JobRow[],
  progress: ProgressRow[],
): string {
  const newest = (rows: { updated_at: number }[]) =>
    rows.reduce((max, r) => Math.max(max, r.updated_at), 0);
  return [
    videos.length,
    jobs.length,
    progress.length,
    newest(videos),
    newest(jobs),
    newest(progress),
  ].join(".");
}
