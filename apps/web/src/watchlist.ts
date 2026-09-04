import { WATCHLIST_MAX_DUE, WATCHLIST_NEW_COUNT, type Video } from "@kel/shared";
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
 * Today's Watchlist, derived in the browser.
 *
 * Everything it needs already arrived in the library manifest, so there is no second request
 * and — more usefully — no second definition of what is Due. The server does decide what
 * "today" is; the phone's clock does not get a vote.
 */
export function buildWatchlist(
  videos: Video[],
  progressOf: ProgressLookup,
  today: string,
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
   * The new ones.
   *
   * CONTEXT.md wants these chosen for overlapping mostly-known Focus Words, which needs
   * Transcripts this app does not have yet. Until then: shortest first, oldest addition as the
   * tiebreak — deliberately deterministic, so the list does not reshuffle itself every time the
   * page re-renders, and so "the one I skipped yesterday" is still there today.
   */
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
