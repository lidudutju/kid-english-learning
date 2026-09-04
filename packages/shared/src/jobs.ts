/**
 * The Ingest Job lifecycle, shared so the Worker, the Agent and the UI cannot drift.
 */

export const JOB_STATUSES = [
  /**
   * A manual upload whose bytes are still arriving from the browser. Only the tab doing the
   * uploading has anything useful to say about it, so the library manifest leaves these out
   * and the Add page shows its own progress instead.
   */
  "receiving",
  "queued",
  "claimed",
  "downloading",
  "normalizing",
  "uploading",
  "done",
  "failed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses an Agent holds a lease on. A lapsed lease here means the job is reclaimable. */
export const LEASED_STATUSES: readonly JobStatus[] = [
  "claimed",
  "downloading",
  "normalizing",
  "uploading",
];

export const TERMINAL_STATUSES: readonly JobStatus[] = ["done", "failed"];

/** Statuses the Agent is allowed to report while it holds the lease. */
export const AGENT_REPORTABLE_STATUSES: readonly JobStatus[] = [
  "downloading",
  "normalizing",
  "uploading",
];

export function isLeased(status: JobStatus): boolean {
  return LEASED_STATUSES.includes(status);
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * How much of the overall bar each stage occupies. Downloading dominates because on a
 * home connection it genuinely does — a progress bar that jumps 0→90% then sits there
 * is worse than no bar.
 */
const STAGE_SPAN: Record<JobStatus, [number, number]> = {
  receiving: [0, 0],
  queued: [0, 0],
  claimed: [0, 2],
  downloading: [2, 70],
  normalizing: [70, 88],
  uploading: [88, 99],
  done: [100, 100],
  failed: [0, 0],
};

/** Overall 0-100 for the UI, from a status plus that stage's own 0-100. */
export function overallPercent(status: JobStatus, stagePercent: number | null): number {
  const [lo, hi] = STAGE_SPAN[status];
  const within = Math.min(100, Math.max(0, stagePercent ?? 0));
  return Math.round(lo + ((hi - lo) * within) / 100);
}

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  receiving: "接收中",
  queued: "排队中",
  claimed: "已领取",
  downloading: "下载中",
  normalizing: "转码中",
  uploading: "上传中",
  done: "完成",
  failed: "失败",
};

/** How long an Agent's claim survives without a heartbeat. */
export const LEASE_SECONDS = 120;

/** Give up after this many attempts rather than looping on a dead link forever. */
export const MAX_ATTEMPTS = 3;

/**
 * Wait this long times the attempt number before handing a failed job back out.
 *
 * The Agent polls every 10s, so with no delay at all the three attempts are spent inside ten
 * seconds and a one-minute network hiccup looks identical to a dead link. One minute, then two,
 * costs nothing (nobody is watching the queue) and is long enough for the common transients.
 */
export const RETRY_BACKOFF_MS = 60_000;
