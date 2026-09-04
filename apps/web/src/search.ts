import type { Video } from "@kel/shared";
import { isPending, type Learning } from "./progress.js";

export const DURATION_BUCKETS = ["any", "short", "medium", "long"] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export const DURATION_LABEL: Record<DurationBucket, string> = {
  any: "任意长度",
  short: "2 分钟内",
  medium: "2–5 分钟",
  long: "5 分钟以上",
};

export const SORT_KEYS = ["newest", "oldest", "shortest", "longest", "title"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABEL: Record<SortKey, string> = {
  newest: "最近添加",
  oldest: "最早添加",
  shortest: "最短优先",
  longest: "最长优先",
  title: "按标题",
};

/**
 * The learning lens.
 *
 * Deliberately not "filter by Stage": the questions actually asked at 7pm are "什么该复习了",
 * "有什么还没放过", "他喜欢哪些" — so the options are those questions, not the data model. Stage
 * itself is visible on every row anyway.
 */
export const LEARNING_VIEWS = ["any", "due", "new", "learning", "loved", "done"] as const;
export type LearningView = (typeof LEARNING_VIEWS)[number];

export const LEARNING_LABEL: Record<LearningView, string> = {
  any: "全部",
  due: "该复习",
  new: "没看过",
  learning: "在学",
  loved: "很喜欢",
  done: "已毕业",
};

export interface Filters {
  query: string;
  duration: DurationBucket;
  learning: LearningView;
  sort: SortKey;
}

export const EMPTY_FILTERS: Filters = {
  query: "",
  duration: "any",
  learning: "any",
  sort: "newest",
};

/**
 * Pre-lowercased searchable text, built once per library version.
 *
 * Search is entirely client-side: the whole library ships in one response, so there is no
 * request per keystroke and no server-side index to keep in sync. At a few hundred Videos this
 * is not a compromise — a linear scan over a few hundred short strings is faster than any
 * round trip could ever be.
 */
export interface IndexedVideo {
  video: Video;
  haystack: string;
}

export function buildIndex(videos: Video[]): IndexedVideo[] {
  return videos.map((video) => ({
    video,
    haystack: [video.title, video.channel ?? ""].join(" ").toLowerCase(),
  }));
}

function matchesDuration(seconds: number | null, bucket: DurationBucket): boolean {
  if (bucket === "any") return true;
  if (seconds === null) return false;
  if (bucket === "short") return seconds < 120;
  if (bucket === "medium") return seconds >= 120 && seconds <= 300;
  return seconds > 300;
}

function matchesLearning(video: Video, view: LearningView, learning: Learning): boolean {
  if (view === "any") return true;
  const p = learning.progressOf(video.id);
  switch (view) {
    case "due":
      return isPending(p, learning.today);
    case "new":
      return p.stage === "new";
    case "learning":
      return p.stage !== "new" && p.stage !== "done";
    case "loved":
      return p.affinity === "loves";
    case "done":
      return p.stage === "done";
  }
}

export function applyFilters(
  index: IndexedVideo[],
  filters: Filters,
  learning: Learning,
): Video[] {
  // Every token must appear somewhere, so "peppa song" narrows instead of widening.
  const tokens = filters.query.toLowerCase().split(/\s+/).filter(Boolean);

  const matched = index
    .filter(
      ({ video, haystack }) =>
        matchesDuration(video.durationSeconds, filters.duration) &&
        matchesLearning(video, filters.learning, learning) &&
        tokens.every((token) => haystack.includes(token)),
    )
    .map(({ video }) => video);

  const sorted = [...matched];
  switch (filters.sort) {
    case "newest":
      sorted.sort((a, b) => b.addedAt - a.addedAt);
      break;
    case "oldest":
      sorted.sort((a, b) => a.addedAt - b.addedAt);
      break;
    case "shortest":
      sorted.sort((a, b) => (a.durationSeconds ?? Infinity) - (b.durationSeconds ?? Infinity));
      break;
    case "longest":
      sorted.sort((a, b) => (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1));
      break;
    case "title":
      sorted.sort((a, b) => a.title.localeCompare(b.title, "en"));
      break;
  }
  return sorted;
}
