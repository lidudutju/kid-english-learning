/**
 * Proof that the day arithmetic and the Review ladder behave the way the app promises.
 *
 * These are the rules the Worker, the browser and the nightly export all read from the same
 * module (packages/shared/src/learning.ts), and every one of them is off-by-one bait: a Review
 * scheduled a day early is invisible, a day key computed in the wrong timezone silently moves
 * midnight, and a Watch threshold that rounds the wrong way never counts. Run it after touching
 * learning.ts:
 *
 *   pnpm check:learning
 */
import {
  addDays,
  advanceReview,
  dayKey,
  daysBetween,
  isDue,
  needsReview,
  REVIEW_LADDER_DAYS,
  watchedOn,
  watchThresholdSeconds,
  type Stage,
} from "../packages/shared/src/learning.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.error(`✗ ${label}\n  got      ${a}\n  expected ${e}`);
}

/* ------------------------------------------------------------------ day keys */

// 2026-09-04 15:00 UTC is already the 4th, 23:00, in Shanghai; one hour later it is the 5th.
check("dayKey before Shanghai midnight", dayKey(Date.UTC(2026, 8, 4, 15, 0)), "2026-09-04");
check("dayKey after Shanghai midnight", dayKey(Date.UTC(2026, 8, 4, 16, 30)), "2026-09-05");
// Same instant read as a UTC date would say the 4th — this is exactly the bug the fixed
// timezone exists to prevent.
check("dayKey is not UTC", dayKey(Date.UTC(2026, 8, 4, 20, 0)), "2026-09-05");

check("addDays across a month end", addDays("2026-09-30", 1), "2026-10-01");
check("addDays across a year end", addDays("2026-12-31", 1), "2027-01-01");
check("addDays over a leap day", addDays("2028-02-28", 1), "2028-02-29");
check("addDays by zero", addDays("2026-09-04", 0), "2026-09-04");
check("addDays by 30", addDays("2026-09-04", 30), "2026-10-04");

check("daysBetween forward", daysBetween("2026-09-04", "2026-09-11"), 7);
check("daysBetween backward", daysBetween("2026-09-11", "2026-09-04"), -7);
check("daysBetween same day", daysBetween("2026-09-04", "2026-09-04"), 0);
check("daysBetween over a year", daysBetween("2026-12-31", "2027-01-01"), 1);

check("watchedOn null", watchedOn(null), null);
check("watchedOn a timestamp", watchedOn(Date.UTC(2026, 8, 4, 16, 30)), "2026-09-05");

/* -------------------------------------------------------------------- ladder */

// One Video, watched every time it comes due: the dates it should land on.
{
  const start = "2026-09-04";
  let step = 0;
  let day = start;
  const schedule: string[] = [];
  for (let i = 0; i < REVIEW_LADDER_DAYS.length + 2; i++) {
    const next = advanceReview(step, day);
    schedule.push(next.nextReviewOn);
    step = next.reviewStep;
    day = next.nextReviewOn;
  }
  // Same day, +1, +2, +4, +7, +15, +30, then +30 forever (CONTEXT.md).
  check("ladder schedule", schedule, [
    "2026-09-04",
    "2026-09-05",
    "2026-09-07",
    "2026-09-11",
    "2026-09-18",
    "2026-10-03",
    "2026-11-02",
    "2026-12-02",
    "2027-01-01",
  ]);
  check("ladder step count", step, REVIEW_LADDER_DAYS.length + 2);
}

// The first rung is the same day on purpose, and that is what makes `isDue` alone unusable as
// "still to do today" — the web app pairs it with the last-watched day.
{
  const today = "2026-09-04";
  const first = advanceReview(0, today);
  check("first Watch stays due today", isDue(first.nextReviewOn, today), true);
  check("already watched today", watchedOn(Date.now()) === dayKey(), true);
}

check("isDue on a null date", isDue(null, "2026-09-04"), false);
check("isDue on a future date", isDue("2026-09-05", "2026-09-04"), false);
check("isDue on today", isDue("2026-09-04", "2026-09-04"), true);
check("isDue on an overdue date", isDue("2026-08-30", "2026-09-04"), true);

/* ------------------------------------------------------- what leaves the ladder */

check("a refused Video is not reviewed", needsReview("familiar", "refuses"), false);
check("a graduated Video is not reviewed", needsReview("done", "loves"), false);
check("a new Video is reviewed", needsReview("new", "neutral"), true);
for (const stage of ["introduced", "familiar", "joining_in", "mastered"] as Stage[]) {
  check(`${stage} is reviewed`, needsReview(stage, "neutral"), true);
}

/* ----------------------------------------------------------------- threshold */

check("a long Video needs 30s", watchThresholdSeconds(600), 30);
check("75s is the crossover", watchThresholdSeconds(75), 30);
check("a 60s Video needs 24s", watchThresholdSeconds(60), 24);
check("a 10s Video needs 4s", watchThresholdSeconds(10), 4);
// No duration means no fraction to take — fall back to the flat 30s rather than to zero, which
// would count a Video as watched the instant it started.
check("unknown duration needs 30s", watchThresholdSeconds(null), 30);
check("zero duration needs 30s", watchThresholdSeconds(0), 30);

if (failures > 0) {
  console.error(`\n${failures} 处不符`);
  process.exit(1);
}
console.log("learning: 日期、复习阶梯、观看门槛都符合预期");
