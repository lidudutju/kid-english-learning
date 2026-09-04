import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { isTerminal } from "@kel/shared";
import { JobList } from "../components/JobList.js";
import { VideoRow } from "../components/VideoRow.js";
import { useLearning } from "../progress.js";
import {
  applyFilters,
  buildIndex,
  DURATION_BUCKETS,
  DURATION_LABEL,
  EMPTY_FILTERS,
  LEARNING_LABEL,
  LEARNING_VIEWS,
  SORT_KEYS,
  SORT_LABEL,
  type Filters,
} from "../search.js";
import type { LibraryState } from "../useLibrary.js";

export function Library({ library }: { library: LibraryState }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const { data, loading, error } = library;

  // Rebuilt only when the library actually changes — a 304 poll leaves `version` alone, so
  // typing never pays for re-indexing.
  const index = useMemo(() => buildIndex(data?.videos ?? []), [data?.version]);
  const learning = useLearning(data);
  const results = useMemo(
    () => applyFilters(index, filters, learning),
    [index, filters, learning],
  );

  const activeJobs = (data?.jobs ?? []).filter((j) => !isTerminal(j.status));

  return (
    <div className="mx-auto max-w-3xl px-4 pb-28 pt-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">英语视频库</h1>
        <span className="text-xs text-slate-500">
          {data ? `${data.videos.length} 个视频` : ""}
        </span>
      </header>

      {/*
        The way in. Due count on the button rather than a separate badge somewhere: this is the
        screen that opens by default, so if there is revision waiting it has to be visible here
        without reading anything.
      */}
      <Link
        to="/today"
        className="min-h-tap mb-3 flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 active:bg-slate-800"
      >
        <span className="text-sm font-medium">今天要看</span>
        <span
          className={`text-xs tabular-nums ${
            learning.dueCount > 0 ? "font-semibold text-amber-400" : "text-slate-500"
          }`}
        >
          {learning.dueCount > 0 ? `${learning.dueCount} 个该复习` : "没有要复习的"}
        </span>
      </Link>

      <input
        value={filters.query}
        onChange={(e) => setFilters({ ...filters, query: e.target.value })}
        placeholder="搜标题、频道"
        type="search"
        autoCapitalize="off"
        autoCorrect="off"
        className="min-h-tap w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 outline-none focus:border-sky-500"
      />

      <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
        <select
          value={filters.learning}
          onChange={(e) =>
            setFilters({ ...filters, learning: e.target.value as Filters["learning"] })
          }
          className="min-h-tap shrink-0 rounded-lg border border-slate-800 bg-slate-900 px-3"
        >
          {LEARNING_VIEWS.map((v) => (
            <option key={v} value={v}>
              {LEARNING_LABEL[v]}
            </option>
          ))}
        </select>
        <select
          value={filters.duration}
          onChange={(e) =>
            setFilters({ ...filters, duration: e.target.value as Filters["duration"] })
          }
          className="min-h-tap shrink-0 rounded-lg border border-slate-800 bg-slate-900 px-3"
        >
          {DURATION_BUCKETS.map((b) => (
            <option key={b} value={b}>
              {DURATION_LABEL[b]}
            </option>
          ))}
        </select>
        <select
          value={filters.sort}
          onChange={(e) => setFilters({ ...filters, sort: e.target.value as Filters["sort"] })}
          className="min-h-tap shrink-0 rounded-lg border border-slate-800 bg-slate-900 px-3"
        >
          {SORT_KEYS.map((k) => (
            <option key={k} value={k}>
              {SORT_LABEL[k]}
            </option>
          ))}
        </select>
      </div>

      {activeJobs.length > 0 && (
        <section className="mt-4">
          <JobList
            jobs={activeJobs}
            agentOnline={data?.agentOnline ?? false}
            onChanged={library.refresh}
          />
        </section>
      )}

      {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}

      {loading && !data ? (
        <p className="mt-8 text-center text-sm text-slate-500">加载中…</p>
      ) : results.length === 0 ? (
        <EmptyState hasVideos={(data?.videos.length ?? 0) > 0} />
      ) : (
        <ul className="mt-4 space-y-2">
          {results.map((video) => (
            <VideoRow
              key={video.id}
              video={video}
              progress={learning.progressOf(video.id)}
              today={learning.today}
            />
          ))}
        </ul>
      )}

      <Link
        to="/add"
        className="fixed bottom-6 right-5 flex h-14 w-14 items-center justify-center rounded-full bg-sky-600 text-3xl leading-none shadow-lg"
        style={{ bottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
        aria-label="添加视频"
      >
        +
      </Link>
    </div>
  );
}

function EmptyState({ hasVideos }: { hasVideos: boolean }) {
  return (
    <div className="mt-16 text-center text-sm text-slate-500">
      {hasVideos ? (
        <p>没有匹配的视频</p>
      ) : (
        <>
          <p>库还是空的。</p>
          <Link to="/add" className="mt-2 inline-block text-sky-400">
            粘一个 YouTube 链接试试
          </Link>
        </>
      )}
    </div>
  );
}
