import type {
  Affinity,
  Focus,
  IngestJob,
  JobStatus,
  Progress,
  SourceKind,
  Stage,
  TranscriptCue,
  TranscriptKind,
  TranscriptResponse,
  Video,
  VideoFocus,
} from "@kel/shared";
import { EMPTY_FOCUS } from "@kel/shared";

/** There is one Learner today, and Progress still belongs to it rather than to the library. */
export const DEFAULT_LEARNER_ID = "default";

export interface VideoRow {
  id: string;
  source_kind: string;
  source_key: string;
  source_url: string | null;
  source_digest: string;
  asset_prefix: string;
  playable_key: string;
  thumb_key: string | null;
  title: string;
  channel: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  published_at: string | null;
  added_at: number;
  updated_at: number;
}

export interface JobRow {
  id: string;
  source_kind: string;
  source_key: string;
  source_url: string | null;
  asset_prefix: string;
  title: string | null;
  status: string;
  stage_percent: number | null;
  detail: string | null;
  error: string | null;
  attempts: number;
  agent_id: string | null;
  lease_expires_at: number | null;
  next_attempt_at: number | null;
  video_id: string | null;
  created_at: number;
  updated_at: number;
  /* Uploads only — NULL for a YouTube link. */
  source_digest: string | null;
  original_key: string | null;
  upload_id: string | null;
  source_bytes: number | null;
}

export interface ProgressRow {
  learner_id: string;
  video_id: string;
  stage: string;
  affinity: string;
  watch_count: number;
  last_watched_at: number | null;
  review_step: number;
  next_review_on: string | null;
  created_at: number;
  updated_at: number;
}

export interface TranscriptRow {
  video_id: string;
  lang: string;
  kind: string;
  cues: string;
  text: string;
  focus_words: string;
  created_at: number;
  updated_at: number;
}

export function toVideo(row: VideoRow, mediaBaseUrl: string, hasTranscript: boolean): Video {
  const base = mediaBaseUrl.replace(/\/+$/, "");
  return {
    id: row.id,
    sourceKind: row.source_kind as SourceKind,
    sourceKey: row.source_key,
    sourceUrl: row.source_url,
    title: row.title,
    channel: row.channel,
    durationSeconds: row.duration_seconds,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    playableUrl: `${base}/${row.playable_key}`,
    thumbUrl: row.thumb_key ? `${base}/${row.thumb_key}` : null,
    addedAt: row.added_at,
    hasTranscript,
  };
}

/**
 * The stored Focus Words, or an empty set.
 *
 * Tolerant of unparseable JSON rather than throwing: this column is written by one code path and
 * read by three, and a Video whose Focus Words cannot be read should still play.
 */
export function parseFocus(json: string): Focus {
  try {
    const parsed = JSON.parse(json) as Partial<Focus>;
    return {
      words: parsed.words ?? [],
      phrases: parsed.phrases ?? [],
    };
  } catch {
    return EMPTY_FOCUS;
  }
}

export function toTranscript(row: TranscriptRow): TranscriptResponse {
  const focus = parseFocus(row.focus_words);
  return {
    videoId: row.video_id,
    lang: row.lang,
    kind: row.kind as TranscriptKind,
    cues: JSON.parse(row.cues) as TranscriptCue[],
    words: focus.words,
    phrases: focus.phrases,
  };
}

/** The manifest's compact form: terms only, no counts. */
export function toVideoFocus(row: Pick<TranscriptRow, "video_id" | "focus_words">): VideoFocus {
  const focus = parseFocus(row.focus_words);
  return {
    videoId: row.video_id,
    words: focus.words.map((w) => w.text),
    phrases: focus.phrases.map((p) => p.text),
  };
}

export function toJob(row: JobRow): IngestJob {
  return {
    id: row.id,
    sourceKind: row.source_kind as SourceKind,
    sourceKey: row.source_key,
    sourceUrl: row.source_url,
    title: row.title,
    status: row.status as JobStatus,
    stagePercent: row.stage_percent,
    detail: row.detail,
    error: row.error,
    attempts: row.attempts,
    agentId: row.agent_id,
    nextAttemptAt: row.next_attempt_at,
    videoId: row.video_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toProgress(row: ProgressRow): Progress {
  return {
    videoId: row.video_id,
    stage: row.stage as Stage,
    affinity: row.affinity as Affinity,
    watchCount: row.watch_count,
    lastWatchedAt: row.last_watched_at,
    reviewStep: row.review_step,
    nextReviewOn: row.next_review_on,
    updatedAt: row.updated_at,
  };
}

/**
 * A D1 batch returns exactly one result per statement. Rather than sprinkle `!` over every
 * destructured batch, make that contract explicit and loud if it is ever broken.
 */
export function rowsOf<T>(batch: D1Result<Record<string, unknown>>[], index: number): T[] {
  const result = batch[index];
  if (!result) throw new Error(`D1 batch is missing result ${index}`);
  return result.results as T[];
}

/** 128 bits of hex — used for Video ids and, more importantly, for R2 key prefixes. */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function playableKey(assetPrefix: string): string {
  return `${assetPrefix}/video.mp4`;
}

export function thumbKey(assetPrefix: string): string {
  return `${assetPrefix}/thumb.jpg`;
}

/**
 * Where an uploaded original waits in the *private* bucket while the Agent is busy.
 *
 * Not in the public one: a Playable is a normalised nursery rhyme behind an unguessable key
 * (docs/adr/0002), but an original is whatever came off someone's phone, and it is deleted as
 * soon as the Video is registered.
 */
export function originalKey(jobId: string): string {
  return `originals/${jobId}`;
}
