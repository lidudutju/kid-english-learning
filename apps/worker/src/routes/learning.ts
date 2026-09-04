import { Hono } from "hono";
import {
  advanceReview,
  dayKey,
  progressUpdateRequest,
  watchRequest,
  watchThresholdSeconds,
  type Progress,
  type Stage,
} from "@kel/shared";
import type { AppBindings } from "../env.js";
import { DEFAULT_LEARNER_ID, randomId, toProgress, type ProgressRow } from "../db.js";

export const learningRoutes = new Hono<AppBindings>();

/**
 * A Video the Learner has not touched has no row — so every read has to be able to invent one
 * rather than treat its absence as an error.
 */
function blankRow(videoId: string, now: number): ProgressRow {
  return {
    learner_id: DEFAULT_LEARNER_ID,
    video_id: videoId,
    stage: "new",
    affinity: "neutral",
    watch_count: 0,
    last_watched_at: null,
    review_step: 0,
    next_review_on: null,
    created_at: now,
    updated_at: now,
  };
}

async function readRow(
  db: D1Database,
  videoId: string,
  now: number,
): Promise<ProgressRow | null> {
  const video = await db
    .prepare(`SELECT duration_seconds FROM videos WHERE id = ?1`)
    .bind(videoId)
    .first<{ duration_seconds: number | null }>();
  if (!video) return null;

  const row = await db
    .prepare(`SELECT * FROM progress WHERE learner_id = ?1 AND video_id = ?2`)
    .bind(DEFAULT_LEARNER_ID, videoId)
    .first<ProgressRow>();

  return row ?? blankRow(videoId, now);
}

/**
 * Write the whole row.
 *
 * Read-modify-write rather than a clever partial UPSERT: there is one person using this app,
 * so there is no concurrent writer to lose, and the alternative is SQL where forgetting one
 * `excluded.` silently resets a counter.
 */
function upsert(db: D1Database, row: ProgressRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO progress
         (learner_id, video_id, stage, affinity, watch_count, last_watched_at,
          review_step, next_review_on, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(learner_id, video_id) DO UPDATE SET
         stage = ?3, affinity = ?4, watch_count = ?5, last_watched_at = ?6,
         review_step = ?7, next_review_on = ?8, updated_at = ?10
       RETURNING *`,
    )
    .bind(
      row.learner_id,
      row.video_id,
      row.stage,
      row.affinity,
      row.watch_count,
      row.last_watched_at,
      row.review_step,
      row.next_review_on,
      row.created_at,
      row.updated_at,
    );
}

/**
 * Stage and Affinity, as judged by the parent.
 *
 * Neither touches the Review ladder. `done` and `refuses` do drop out of Review, but that is
 * decided when the watchlist is built, not by clearing the schedule here — so changing your
 * mind about a Video restores where it had got to instead of starting it over.
 */
learningRoutes.patch("/:id/progress", async (c) => {
  const parsed = progressUpdateRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "请求格式不对" }, 400);

  const now = Date.now();
  const row = await readRow(c.env.DB, c.req.param("id"), now);
  if (!row) return c.json({ error: "找不到这个视频" }, 404);

  const next: ProgressRow = {
    ...row,
    stage: parsed.data.stage ?? row.stage,
    affinity: parsed.data.affinity ?? row.affinity,
    updated_at: now,
  };

  const written = await upsert(c.env.DB, next).first<ProgressRow>();
  return c.json<{ progress: Progress }>({ progress: toProgress(written ?? next) });
});

/**
 * Record a Watch and climb one rung of the Review ladder.
 *
 * The threshold is checked here as well as in the player, because it is the definition of a
 * Watch and not a UI detail — and because a Preview must never be able to reach this route at
 * all (the player simply does not call it).
 */
learningRoutes.post("/:id/watches", async (c) => {
  const parsed = watchRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "请求格式不对" }, 400);

  const videoId = c.req.param("id");
  const now = Date.now();

  const video = await c.env.DB.prepare(`SELECT duration_seconds FROM videos WHERE id = ?1`)
    .bind(videoId)
    .first<{ duration_seconds: number | null }>();
  if (!video) return c.json({ error: "找不到这个视频" }, 404);

  const row =
    (await c.env.DB.prepare(`SELECT * FROM progress WHERE learner_id = ?1 AND video_id = ?2`)
      .bind(DEFAULT_LEARNER_ID, videoId)
      .first<ProgressRow>()) ?? blankRow(videoId, now);

  // Half a second of slack: `timeupdate` fires about four times a second, so the client's
  // total lands just under the threshold as often as just over it.
  const threshold = watchThresholdSeconds(video.duration_seconds);
  if (parsed.data.secondsWatched + 0.5 < threshold) {
    return c.json({ counted: false, progress: toProgress(row) });
  }

  const today = dayKey(now);
  const review = advanceReview(row.review_step, today);

  /**
   * The one Stage transition a machine is allowed to make. It cannot see whether a toddler
   * understood anything, but "has been watched" and "never been watched" is exactly the
   * difference between `introduced` and `new` — leaving a watched Video sitting on `new` would
   * just be wrong, and it costs the parent a pointless tap.
   */
  const stage: Stage = row.stage === "new" ? "introduced" : (row.stage as Stage);

  const next: ProgressRow = {
    ...row,
    stage,
    watch_count: row.watch_count + 1,
    last_watched_at: now,
    review_step: review.reviewStep,
    next_review_on: review.nextReviewOn,
    updated_at: now,
  };

  const batch = await c.env.DB.batch<ProgressRow>([
    c.env.DB.prepare(
      `INSERT INTO watches (id, learner_id, video_id, counted_at, seconds_watched, counted_on)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(randomId(), DEFAULT_LEARNER_ID, videoId, now, parsed.data.secondsWatched, today),
    upsert(c.env.DB, next),
  ]);

  const written = batch[1]?.results?.[0];
  return c.json({ counted: true, progress: toProgress(written ?? next) });
});
