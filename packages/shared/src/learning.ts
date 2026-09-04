/**
 * Stage, Affinity, Watch and the Review ladder — the vocabulary in CONTEXT.md, expressed once
 * so the Worker, the browser and the nightly export cannot disagree about what "due" means.
 */

/* ------------------------------------------------------------------------- calendar */

/**
 * Review lives on days, not on milliseconds, and the family is in one place. Pinning the
 * timezone here means "due today" is the same day for the Worker (UTC), the phone, and a
 * backup read next year — rather than flipping at 08:00 local because a Date got serialised.
 */
export const FAMILY_TZ = "Asia/Shanghai";

/** A calendar day as `YYYY-MM-DD` in the family's timezone. */
export type DayKey = string;

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: FAMILY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function dayKey(timestamp: number = Date.now()): DayKey {
  const parts = dayFormatter.formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Day arithmetic on the key itself: no timezone can creep back in between two midnights. */
export function addDays(day: DayKey, days: number): DayKey {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

export function daysBetween(from: DayKey, to: DayKey): number {
  const at = (day: DayKey) => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/* ---------------------------------------------------------------------------- stage */

export const STAGES = [
  "new",
  "introduced",
  "familiar",
  "joining_in",
  "mastered",
  "done",
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  new: "没看过",
  introduced: "看过了",
  familiar: "熟悉",
  joining_in: "跟着唱",
  mastered: "会用了",
  done: "毕业",
};

/**
 * The one line that decides which chip to tap. `familiar` and `joining_in` are deliberately
 * two stages: a 3-year-old who understands but stays silent is in a normal silent period.
 */
export const STAGE_HINT: Record<Stage, string> = {
  new: "还没放给他看过",
  introduced: "看过一两次，还很陌生",
  familiar: "有反应、会指、会跟着动",
  joining_in: "会跟着唱、跟着做动作",
  mastered: "离开屏幕也会说出来",
  done: "不用再复习了",
};

/** Stages that stop taking part in Review — `done` graduated, and that is the whole point. */
export function needsReview(stage: Stage, affinity: Affinity): boolean {
  return stage !== "done" && affinity !== "refuses";
}

/* ------------------------------------------------------------------------- affinity */

export const AFFINITIES = ["loves", "neutral", "refuses"] as const;
export type Affinity = (typeof AFFINITIES)[number];

export const AFFINITY_LABEL: Record<Affinity, string> = {
  loves: "很喜欢",
  neutral: "还行",
  refuses: "不肯看",
};

/* ---------------------------------------------------------------------------- watch */

/** A viewing counts at 30 seconds, or 40% of the Video, whichever comes first. */
export const WATCH_MIN_SECONDS = 30;
export const WATCH_MIN_FRACTION = 0.4;

export function watchThresholdSeconds(durationSeconds: number | null): number {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return WATCH_MIN_SECONDS;
  }
  return Math.min(WATCH_MIN_SECONDS, durationSeconds * WATCH_MIN_FRACTION);
}

/* --------------------------------------------------------------------------- review */

/**
 * The ladder: same day, +1, +2, +4, +7, +15, +30.
 *
 * Fixed and short on purpose — an adult SRS algorithm tuned on flashcard recall has nothing
 * useful to say about a toddler, and "watch it again today" is the single most valuable rung.
 */
export const REVIEW_LADDER_DAYS = [0, 1, 2, 4, 7, 15, 30] as const;

/**
 * The gap after the Watch that has just happened, given how many came before it.
 *
 * Past the top rung the gap stays at 30 days rather than running off the end; nothing graduates
 * by itself, 毕业 is the parent's call.
 */
export function reviewIntervalDays(reviewStep: number): number {
  const index = Math.min(Math.max(reviewStep, 0), REVIEW_LADDER_DAYS.length - 1);
  return REVIEW_LADDER_DAYS[index]!;
}

export interface ReviewState {
  reviewStep: number;
  nextReviewOn: DayKey;
}

/**
 * Advance the ladder one rung. Called once per counted Watch, never on a Preview.
 *
 * The first rung is 0 days, so a Video stays Due on the day it was first watched — CONTEXT.md
 * calls that the most valuable rung, and a toddler asking for the same song again an hour later
 * is the behaviour it is built around. It does mean "Due" alone cannot drive Today's list;
 * `watchedOn` is what tells the list what has already been done today.
 */
export function advanceReview(reviewStep: number, today: DayKey): ReviewState {
  return {
    reviewStep: reviewStep + 1,
    nextReviewOn: addDays(today, reviewIntervalDays(reviewStep)),
  };
}

/** The day a timestamp fell on, in the family's timezone. Null passes straight through. */
export function watchedOn(timestamp: number | null): DayKey | null {
  return timestamp === null ? null : dayKey(timestamp);
}

export function isDue(nextReviewOn: DayKey | null, today: DayKey): boolean {
  return nextReviewOn !== null && nextReviewOn <= today;
}

/** How short a daily session should be. Attention at this age runs 10–15 minutes. */
export const WATCHLIST_MAX_DUE = 6;
/** Plus one or two new Videos, so the list is never only revision. */
export const WATCHLIST_NEW_COUNT = 2;
