import { z } from "zod";
import { JOB_STATUSES, AGENT_REPORTABLE_STATUSES } from "./jobs.js";
import { AFFINITIES, STAGES } from "./learning.js";
import { MAX_UPLOAD_BYTES } from "./uploads.js";

export const SOURCE_KINDS = ["youtube", "upload"] as const;
export const sourceKind = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKind>;

/* ------------------------------------------------------------------ read models */

/** One Video as the library manifest carries it. URLs are absolute and public. */
export const video = z.object({
  id: z.string(),
  sourceKind,
  sourceKey: z.string(),
  sourceUrl: z.string().nullable(),
  title: z.string(),
  channel: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  bytes: z.number().nullable(),
  playableUrl: z.string(),
  thumbUrl: z.string().nullable(),
  addedAt: z.number(),
});
export type Video = z.infer<typeof video>;

export const ingestJob = z.object({
  id: z.string(),
  sourceKind,
  sourceKey: z.string(),
  sourceUrl: z.string().nullable(),
  title: z.string().nullable(),
  status: z.enum(JOB_STATUSES),
  stagePercent: z.number().nullable(),
  detail: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.number(),
  agentId: z.string().nullable(),
  /** Set only while a failed-but-retryable job is waiting out its backoff. */
  nextAttemptAt: z.number().nullable(),
  videoId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type IngestJob = z.infer<typeof ingestJob>;

export const stage = z.enum(STAGES);
export const affinity = z.enum(AFFINITIES);

/**
 * What one Learner has done with one Video.
 *
 * Carried alongside the Videos rather than inside them: Progress belongs to a Learner, and the
 * day there are two of them the Video read model must not have to change.
 */
export const progress = z.object({
  videoId: z.string(),
  stage,
  affinity,
  watchCount: z.number(),
  lastWatchedAt: z.number().nullable(),
  /** How many rungs of the Review ladder this Video has climbed. */
  reviewStep: z.number(),
  /** `YYYY-MM-DD` in the family's timezone, or null when Review does not apply. */
  nextReviewOn: z.string().nullable(),
  updatedAt: z.number(),
});
export type Progress = z.infer<typeof progress>;

/** Everything the library page needs, in one response. */
export const libraryResponse = z.object({
  version: z.string(),
  videos: z.array(video),
  jobs: z.array(ingestJob),
  /**
   * One entry per Video the Learner has actually touched. A Video with no entry is `new` and
   * neutral — no point shipping a few hundred rows of defaults.
   */
  progress: z.array(progress),
  /**
   * Today, as the server sees it. What is Due must not depend on the phone's clock or on which
   * side of midnight its timezone happens to be.
   */
  today: z.string(),
  /** True when no Agent has polled recently — lets the UI say so instead of spinning. */
  agentOnline: z.boolean(),
  agentLastSeenAt: z.number().nullable(),
});
export type LibraryResponse = z.infer<typeof libraryResponse>;

/* --------------------------------------------------------------- browser → API */

export const loginRequest = z.object({
  password: z.string().min(1).max(200),
});

export const addYoutubeRequest = z.object({
  url: z.string().min(1).max(2000),
});

export const addYoutubeResponse = z.object({
  jobId: z.string(),
  sourceKey: z.string(),
});

/* ------------------------------------------------------------- browser → API: upload */

/**
 * Announce a file before uploading it. The digest is computed in the browser, so a Duplicate
 * is refused here — before the bytes, not after (docs/adr/0004).
 */
export const uploadPrepareRequest = z.object({
  sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  filename: z.string().min(1).max(400),
  bytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  title: z.string().max(500).nullish(),
});

export const uploadPrepareResponse = z.object({
  jobId: z.string(),
  /** Fixed by R2's multipart rules; the browser must slice at exactly this size. */
  partBytes: z.number(),
  partCount: z.number(),
});

export const uploadPartResponse = z.object({
  partNumber: z.number(),
  etag: z.string(),
});

export const uploadCompleteRequest = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }))
    .min(1),
});

/* --------------------------------------------------------- browser → API: learning */

/** Stage and Affinity are both parent judgements, so both arrive by hand and separately. */
export const progressUpdateRequest = z
  .object({ stage: stage.optional(), affinity: affinity.optional() })
  .refine((v) => v.stage !== undefined || v.affinity !== undefined, {
    message: "nothing to update",
  });

/**
 * A Watch, reported by the player once it has got far enough to count. The seconds are the
 * seconds actually played — seeking forward does not earn them.
 */
export const watchRequest = z.object({
  secondsWatched: z.number().nonnegative().max(24 * 3600),
});

export const watchResponse = z.object({
  counted: z.boolean(),
  progress,
});

/* ----------------------------------------------------------------- Agent → API */

export const agentClaimRequest = z.object({
  agentId: z.string().min(1).max(64),
  /** Shown in the UI so it is obvious which machine at home is doing the work. */
  hostname: z.string().max(200).nullish(),
});

/**
 * What the Agent needs to actually do the work.
 *
 * `assetPrefix` is assigned by the Worker when the job is created, not by the Agent, so a
 * retry re-uploads over the same keys instead of stranding the previous attempt's bytes.
 */
export const agentClaimResponse = z.object({
  job: z
    .object({
      id: z.string(),
      sourceKind,
      sourceKey: z.string(),
      sourceUrl: z.string().nullable(),
      assetPrefix: z.string(),
      attempts: z.number(),
      leaseExpiresAt: z.number(),
      /**
       * Set for uploads only. The Agent fetches the original from the Worker instead of
       * running yt-dlp, and the digest was computed by the browser rather than by the Agent —
       * it re-computes it anyway, and the Worker refuses a mismatch.
       */
      title: z.string().nullable(),
      sourceDigest: z.string().nullable(),
      sourceBytes: z.number().nullable(),
    })
    .nullable(),
});
export type AgentClaim = z.infer<typeof agentClaimResponse>;
export type AgentClaimJob = NonNullable<AgentClaim["job"]>;

export const agentProgressRequest = z.object({
  agentId: z.string(),
  status: z.enum(AGENT_REPORTABLE_STATUSES as unknown as [string, ...string[]]),
  stagePercent: z.number().min(0).max(100).nullable().optional(),
  detail: z.string().max(300).nullable().optional(),
});

/**
 * Probed facts about the Playable the Agent just uploaded. Object keys are absent on
 * purpose — the Worker derives them from the `assetPrefix` it handed out.
 */
export const agentCompleteRequest = z.object({
  agentId: z.string(),
  sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  hasThumb: z.boolean(),
  bytes: z.number().int().positive(),
  title: z.string().min(1).max(500),
  channel: z.string().max(300).nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  publishedAt: z.string().max(40).nullable(),
});

export const agentFailRequest = z.object({
  agentId: z.string(),
  error: z.string().max(2000),
  /** False for problems retrying cannot fix (deleted video, private video). */
  retryable: z.boolean().default(true),
});

export const agentCompleteResponse = z.object({
  videoId: z.string(),
});
