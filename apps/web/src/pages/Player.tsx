import { useCallback, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { watchThresholdSeconds, type Progress } from "@kel/shared";
import { api } from "../api.js";
import { BackLink } from "../components/BackLink.js";
import { ProgressPanel } from "../components/ProgressPanel.js";
import { formatBytes, formatDuration, formatRelative } from "../format.js";
import { usePreviewMode } from "../preview.js";
import { useLearning } from "../progress.js";
import type { LibraryState } from "../useLibrary.js";
import { useWatchTracker } from "../useWatchTracker.js";

export function Player({ library }: { library: LibraryState }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [preview, setPreview] = usePreviewMode();

  /**
   * The last Progress this page itself wrote.
   *
   * A tap has to land instantly, and the manifest only catches up on the next poll — so the
   * locally written row wins until the server's is at least as new.
   */
  const [written, setWritten] = useState<Progress | null>(null);

  const { progressOf, today } = useLearning(library.data);
  const video = library.data?.videos.find((v) => v.id === id);

  const onProgress = useCallback(
    (next: Progress) => {
      setWritten(next);
      // Progress is part of the library ETag, so this pulls the new row into every other screen.
      library.refresh();
    },
    [library],
  );

  const tracker = useWatchTracker(video, !preview, onProgress);
  const backTo = location.state === "today" ? "/today" : "/";

  if (!library.data) {
    return <p className="p-8 text-center text-sm text-stone">加载中…</p>;
  }
  if (!video) {
    return (
      <div className="p-8 text-center text-sm text-stone">
        <p>找不到这个视频。</p>
        <Link to="/" className="mt-2 inline-block font-medium text-brand-blue">
          回到列表
        </Link>
      </div>
    );
  }

  const server = progressOf(video.id);
  const progress =
    written && written.videoId === video.id && written.updatedAt >= server.updatedAt
      ? written
      : server;

  async function remove() {
    if (!video) return;
    setRemoving(true);
    try {
      await api.removeVideo(video.id);
      library.refresh();
      navigate("/", { replace: true });
    } catch {
      setRemoving(false);
    }
  }

  return (
    <div className="pb-16">
      {/*
        Preview mode is sticky, so the only thing standing between "我先看一眼" and a silently
        broken Watch count is this bar. It is loud on purpose.
      */}
      {preview && (
        <div className="flex items-center justify-between gap-3 bg-ink px-4 py-2 text-sm font-medium text-white">
          <span>预览模式 · 这次不算他看过</span>
          <button
            onClick={() => setPreview(false)}
            className="min-h-tap shrink-0 rounded-full bg-brand-yellow px-4 text-xs font-semibold text-ink active:bg-brand-yellow-deep"
          >
            关掉
          </button>
        </div>
      )}

      <div className="bg-black">
        {/*
          playsInline lets it play in place instead of jumping to fullscreen; remote playback
          is deliberately left enabled so the AirPlay button stays in the native controls.
          preload="metadata" is what makes the first tap responsive — the Playable has its moov
          atom at the front, so Safari needs only the head of the file to be ready to draw.
        */}
        <video
          key={video.id}
          ref={tracker.ref}
          src={video.playableUrl}
          poster={video.thumbUrl ?? undefined}
          controls
          playsInline
          preload="metadata"
          className="mx-auto max-h-[70vh] w-full bg-black"
        />
      </div>

      <div className="mx-auto max-w-2xl px-4 pt-4">
        <div className="mb-3 flex items-center gap-3">
          <BackLink to={backTo} />
          <h1 className="min-w-0 flex-1 text-base font-medium leading-snug text-ink">{video.title}</h1>
        </div>

        <dl className="space-y-1 text-xs text-stone">
          {video.channel && <dd>{video.channel}</dd>}
          <dd>
            {[
              formatDuration(video.durationSeconds),
              video.height ? `${video.height}p` : null,
              formatBytes(video.bytes),
              `添加于 ${formatRelative(video.addedAt)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </dd>
          {video.sourceUrl && (
            <dd>
              <a
                href={video.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-brand-blue"
              >
                在 YouTube 上打开
              </a>
            </dd>
          )}
        </dl>

        <ProgressPanel
          videoId={video.id}
          progress={progress}
          today={today}
          secondsWatched={tracker.secondsWatched}
          counted={tracker.counted}
          watchThreshold={watchThresholdSeconds(video.durationSeconds)}
          preview={preview}
          onProgress={onProgress}
        />

        {!preview && (
          <button
            onClick={() => setPreview(true)}
            className="min-h-tap mt-4 text-xs text-faint"
          >
            我自己先看一眼（不计入）
          </button>
        )}

        {/*
          Removal is permanent and there is no undo (see CONTEXT.md), so it takes two taps.
          The nightly export can bring back the title and the metadata, never the bytes.
        */}
        <div className="mt-8 border-t border-hairline pt-4">
          {confirmingRemove ? (
            <div className="space-y-3">
              <p className="text-sm text-faint">
                彻底删除这个视频，文件和记录都不留，无法撤销。
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => void remove()}
                  disabled={removing}
                  className="min-h-tap flex-1 rounded-full bg-coral-dark px-4 py-2 text-sm font-medium text-white disabled:bg-hairline disabled:text-mist"
                >
                  {removing ? "删除中…" : "确认删除"}
                </button>
                <button
                  onClick={() => setConfirmingRemove(false)}
                  className="min-h-tap flex-1 rounded-full border border-hairline-strong bg-canvas px-4 py-2 text-sm font-medium text-ink"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingRemove(true)}
              className="min-h-tap text-sm text-stone"
            >
              删除这个视频
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
