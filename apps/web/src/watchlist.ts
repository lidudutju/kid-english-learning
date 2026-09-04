import {
  knownRatio,
  stageKnowsWords,
  WATCHLIST_MAX_DUE,
  WATCHLIST_NEW_COUNT,
  type Video,
  type VideoFocus,
} from "@kel/shared";
import { isDueNow, isPending, watchedToday, type ProgressLookup } from "./progress.js";

export interface Watchlist {
  /** What is Due and not watched yet today, most overdue first. */
  due: Video[];
  /** One or two new Videos, so a session is never only revision. */
  fresh: Video[];
  /**
   * Watched today and still on the same-day rung of the ladder — an offer, not a task. Kept
   * separate so finishing something removes it from the list that has a number on it.
   */
  again: Video[];
}

/**
 * Every word the Learner has met in a Video he has got somewhere with.
 *
 * "Somewhere" is `stageKnowsWords` — Familiar and up. The threshold matters: counting anything
 * he has merely been shown would make the whole library look familiar after a week, and then this
 * function would just be recommending at random again.
 */
function knownWords(
  videos: Video[],
  focusOf: Map<string, VideoFocus>,
  progressOf: ProgressLookup,
): Set<string> {
  const known = new Set<string>();
  for (const video of videos) {
    if (!stageKnowsWords(progressOf(video.id).stage)) continue;
    for (const word of focusOf.get(video.id)?.words ?? []) known.add(word);
  }
  return known;
}

/**
 * Today's Watchlist, derived in the browser.
 *
 * Everything it needs already arrived in the library manifest — including the Focus Words, which
 * ride along precisely because they are small — so there is no second request and, more usefully,
 * no second definition of what is Due. The server does decide what "today" is; the phone's clock
 * does not get a vote.
 */
export function buildWatchlist(
  videos: Video[],
  progressOf: ProgressLookup,
  today: string,
  focus: VideoFocus[] = [],
): Watchlist {
  const due = videos
    .filter((v) => isPending(progressOf(v.id), today))
    .sort((a, b) => {
      const byDate = (progressOf(a.id).nextReviewOn ?? "").localeCompare(
        progressOf(b.id).nextReviewOn ?? "",
      );
      // Longest overdue first; ties broken by the shorter Video, because a 10–15 minute
      // attention span is the real budget.
      return byDate !== 0
        ? byDate
        : (a.durationSeconds ?? Infinity) - (b.durationSeconds ?? Infinity);
    })
    .slice(0, WATCHLIST_MAX_DUE);

  /**
   * The new ones — the ones whose words he mostly already has.
   *
   * This is what CONTEXT.md asks for: a new Video built out of Focus Words he knows is one he can
   * join in with tonight, whereas one with nothing familiar in it is a cold start. Overlap is
   * bucketed to one decimal rather than compared exactly, so the tiebreaks below still do the
   * work — 5 of 8 words versus 4 of 7 is not a real difference, and letting a hair's-width
   * difference in ratio decide would mean a 12-minute video beating a 90-second one.
   *
   * Shortest-first is still the fallback, and on a cold start (nothing Familiar yet, or no
   * Transcripts at all) every overlap is 0 and that is all this is. Deterministic throughout, so
   * the list does not reshuffle on re-render and "the one I skipped yesterday" is still there.
   */
  const focusOf = new Map(focus.map((f) => [f.videoId, f]));
  const known = knownWords(videos, focusOf, progressOf);
  const familiarity = (video: Video) =>
    Math.round(knownRatio(focusOf.get(video.id)?.words ?? [], known) * 10) / 10;

  const dueIds = new Set(due.map((v) => v.id));
  const fresh = videos
    .filter((v) => {
      const p = progressOf(v.id);
      return (
        !dueIds.has(v.id) && p.stage === "new" && p.affinity !== "refuses" && p.watchCount === 0
      );
    })
    .sort(
      (a, b) =>
        familiarity(b) - familiarity(a) ||
        (a.durationSeconds ?? Infinity) - (b.durationSeconds ?? Infinity) ||
        a.addedAt - b.addedAt,
    )
    .slice(0, WATCHLIST_NEW_COUNT);

  // Already watched today, and the ladder says today again. Most recent last: the thing just
  // finished belongs at the bottom, not the top.
  const again = videos
    .filter((v) => {
      const p = progressOf(v.id);
      return isDueNow(p, today) && watchedToday(p, today);
    })
    .sort((a, b) => (progressOf(a.id).lastWatchedAt ?? 0) - (progressOf(b.id).lastWatchedAt ?? 0))
    .slice(0, WATCHLIST_MAX_DUE);

  return { due, fresh, again };
}
