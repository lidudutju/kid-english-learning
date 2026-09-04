import { useMemo } from "react";
import {
  isDue,
  needsReview,
  watchedOn,
  type LibraryResponse,
  type Progress,
  type Video,
} from "@kel/shared";

/**
 * A Video nobody has touched has no row on the server, so every screen needs the same invented
 * default rather than a null check of its own.
 */
export function blankProgress(videoId: string): Progress {
  return {
    videoId,
    stage: "new",
    affinity: "neutral",
    watchCount: 0,
    lastWatchedAt: null,
    reviewStep: 0,
    nextReviewOn: null,
    updatedAt: 0,
  };
}

export type ProgressLookup = (videoId: string) => Progress;

export function progressLookup(rows: Progress[]): ProgressLookup {
  const byId = new Map(rows.map((p) => [p.videoId, p]));
  return (videoId) => byId.get(videoId) ?? blankProgress(videoId);
}

/** Due by the ladder — which, on the same-day rung, includes something just watched. */
export function isDueNow(progress: Progress, today: string): boolean {
  return (
    needsReview(progress.stage, progress.affinity) && isDue(progress.nextReviewOn, today)
  );
}

export function watchedToday(progress: Progress, today: string): boolean {
  return watchedOn(progress.lastWatchedAt) === today;
}

/**
 * Still to do today.
 *
 * The distinction that keeps the app honest: the first rung of the ladder is the same day, so a
 * Video stays Due right after being watched. Counting those would leave the badge stuck at the
 * same number all evening no matter what the Learner watched, which reads as broken.
 */
export function isPending(progress: Progress, today: string): boolean {
  return isDueNow(progress, today) && !watchedToday(progress, today);
}

export interface Learning {
  progressOf: ProgressLookup;
  today: string;
  /** How many Videos are still waiting today. */
  dueCount: number;
}

/** Everything the Progress-aware screens need, derived once per library version. */
export function readLearning(data: LibraryResponse | null): Learning {
  const progressOf = progressLookup(data?.progress ?? []);
  const today = data?.today ?? "";
  const dueCount = (data?.videos ?? []).filter((v: Video) =>
    isPending(progressOf(v.id), today),
  ).length;
  return { progressOf, today, dueCount };
}

/**
 * The same thing, stable across renders.
 *
 * Keyed on the manifest version because everything downstream — the Watchlist, the filtered
 * list — memoises on this object; rebuilding it on every render would quietly turn those
 * `useMemo`s back into plain function calls.
 */
export function useLearning(data: LibraryResponse | null): Learning {
  return useMemo(() => readLearning(data), [data?.version]);
}
