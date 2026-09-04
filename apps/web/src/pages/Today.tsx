import { useMemo } from "react";
import { Link } from "react-router-dom";
import { BackLink } from "../components/BackLink.js";
import { VideoRow } from "../components/VideoRow.js";
import { usePreviewMode } from "../preview.js";
import { useLearning } from "../progress.js";
import type { LibraryState } from "../useLibrary.js";
import { buildWatchlist } from "../watchlist.js";

/**
 * Today's Watchlist.
 *
 * The whole point of the app in one screen: what is Due, plus one or two new things so a
 * session is never only revision. There is no "done" button and no session state — watching
 * something pushes its next Review into the future, so it simply leaves this list. That is why
 * the list can be recomputed from scratch on every render and still feel like progress.
 */
export function Today({ library }: { library: LibraryState }) {
  const { data, loading } = library;
  const learning = useLearning(data);
  const [preview] = usePreviewMode();

  // `learning` is keyed on the manifest version, which covers Videos and Progress both, so the
  // list is rebuilt exactly when something actually changed — and is stable while scrolling.
  const watchlist = useMemo(
    () => buildWatchlist(data?.videos ?? [], learning.progressOf, learning.today),
    [data?.videos, learning],
  );

  // The header counts what is actually left to do; 看过了 sits below it as an offer.
  const todo = [...watchlist.due, ...watchlist.fresh];
  const total = todo.length;
  const shown = total + watchlist.again.length;
  const minutes = Math.round(
    todo.reduce((sum, v) => sum + (v.durationSeconds ?? 0), 0) / 60,
  );

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-4">
      <header className="mb-4 flex items-center gap-3">
        <BackLink to="/" />
        <h1 className="flex-1 text-lg font-medium tracking-tight text-ink">今天要看</h1>
        {total > 0 && (
          <span className="text-xs text-stone tabular-nums">
            {total} 个 · 约 {minutes} 分钟
          </span>
        )}
      </header>

      {preview && (
        <p className="mb-4 rounded-full bg-surface-yellow px-4 py-2 text-xs font-semibold text-yellow-dark">
          预览模式还开着，现在看什么都不会计入他的记录。
        </p>
      )}

      {loading && !data ? (
        <p className="mt-8 text-center text-sm text-stone">加载中…</p>
      ) : shown === 0 ? (
        <Nothing hasVideos={(data?.videos.length ?? 0) > 0} />
      ) : (
        <>
          {total === 0 && (
            <p className="text-sm font-medium text-success">今天该看的都看完了。</p>
          )}

          {watchlist.due.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-faint">该复习了</h2>
              <ul className="space-y-2">
                {watchlist.due.map((video) => (
                  <VideoRow
                    key={video.id}
                    video={video}
                    progress={learning.progressOf(video.id)}
                    today={learning.today}
                    from="today"
                  />
                ))}
              </ul>
            </section>
          )}

          {watchlist.fresh.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-sm font-medium text-faint">新的</h2>
              <ul className="space-y-2">
                {watchlist.fresh.map((video) => (
                  <VideoRow
                    key={video.id}
                    video={video}
                    progress={learning.progressOf(video.id)}
                    today={learning.today}
                    from="today"
                  />
                ))}
              </ul>
            </section>
          )}

          {/*
            The same-day rung. Not part of the count above — it is what to put on if he asks for
            it again, not something left to get through.
          */}
          {watchlist.again.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-sm font-medium text-faint">
                今天看过了 · 他想再看就再放
              </h2>
              <ul className="space-y-2 opacity-70">
                {watchlist.again.map((video) => (
                  <VideoRow
                    key={video.id}
                    video={video}
                    progress={learning.progressOf(video.id)}
                    today={learning.today}
                    from="today"
                  />
                ))}
              </ul>
            </section>
          )}

          <p className="mt-6 text-xs leading-relaxed text-stone">
            看满 30 秒（或视频的 40%）才算一遍；算过之后它就从上面的列表移下去，下次复习按
            当天·1·2·4·7·15·30 天往后排。
          </p>
        </>
      )}
    </div>
  );
}

function Nothing({ hasVideos }: { hasVideos: boolean }) {
  return (
    <div className="mt-16 text-center text-sm text-stone">
      {hasVideos ? (
        <>
          <p>今天没有要复习的了。</p>
          <Link to="/" className="mt-2 inline-block font-medium text-brand-blue">
            去库里挑一个
          </Link>
        </>
      ) : (
        <>
          <p>库还是空的。</p>
          <Link to="/add" className="mt-2 inline-block font-medium text-brand-blue">
            先加一个视频
          </Link>
        </>
      )}
    </div>
  );
}
