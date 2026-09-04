import { useEffect, useRef, useState } from "react";
import { TRANSCRIPT_KIND_LABEL, type Video } from "@kel/shared";
import { formatDuration } from "../format.js";
import { activeCueIndex, useTranscript } from "../transcript.js";

/**
 * Focus Words and the Transcript, under the player.
 *
 * The Focus Words come first and are always visible: they are the answer to "这个视频教什么",
 * which is the question a parent has before pressing play, and there are never more than a
 * handful. The cues below them are for singing along, so they follow playback and can be tapped
 * to jump — a toddler asking for "the diamond bit" is a seek, not a rewind.
 */
export function TranscriptPanel({
  video,
  player,
}: {
  video: Video;
  /** The `<video>` element, once mounted. Null until then. */
  player: HTMLVideoElement | null;
}) {
  const { transcript, loading, error } = useTranscript(video.id, video.hasTranscript);
  const [active, setActive] = useState(-1);
  const [following, setFollowing] = useState(true);
  const list = useRef<HTMLOListElement>(null);

  const cues = transcript?.cues ?? [];

  // One `timeupdate` listener, and state that only changes when the *line* changes — not four
  // times a second. Without that guard this panel would re-render the whole time something is
  // playing, on the one screen where dropped frames are the thing being watched for.
  useEffect(() => {
    if (!player || cues.length === 0) return;
    const onTime = () => {
      const next = activeCueIndex(cues, player.currentTime);
      setActive((prev) => (prev === next ? prev : next));
    };
    onTime();
    player.addEventListener("timeupdate", onTime);
    player.addEventListener("seeked", onTime);
    return () => {
      player.removeEventListener("timeupdate", onTime);
      player.removeEventListener("seeked", onTime);
    };
  }, [player, cues]);

  /**
   * Keep the current line in view.
   *
   * `scrollTop` on the list rather than `scrollIntoView`, which walks up to the nearest
   * scrollable ancestor and would drag the whole page — including the video out of frame —
   * every few seconds.
   */
  useEffect(() => {
    const box = list.current;
    if (!box || !following || active < 0) return;
    const el = box.children[active] as HTMLElement | undefined;
    if (!el) return;
    box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
  }, [active, following]);

  if (!video.hasTranscript) {
    return (
      <section className="mt-6 border-t border-hairline pt-4">
        <p className="text-xs leading-relaxed text-stone">
          {video.sourceKind === "upload"
            ? "手机上传的视频没有字幕，也就没有重点词。"
            : "这个视频在 YouTube 上没有英文字幕，所以没有字幕和重点词。"}
        </p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="mt-6 border-t border-hairline pt-4">
        <p className="text-xs text-stone">字幕加载中…</p>
      </section>
    );
  }

  if (error || !transcript) {
    return (
      <section className="mt-6 border-t border-hairline pt-4">
        <p className="text-xs text-stone">{error ?? "这个视频没有字幕。"}</p>
      </section>
    );
  }

  return (
    <section className="mt-6 border-t border-hairline pt-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-faint">重点词</h2>
        <span className="text-xs text-mist">
          {TRANSCRIPT_KIND_LABEL[transcript.kind]} · {transcript.lang}
        </span>
      </div>

      {transcript.words.length === 0 && transcript.phrases.length === 0 ? (
        // A Transcript with nothing repeated in it. Rare, and worth saying rather than showing
        // an empty row: it means the Video says a lot of things once, which is itself a hint
        // that it is not a song.
        <p className="text-xs text-stone">这个视频没有重复够多次的词。</p>
      ) : (
        <>
          <ul className="flex flex-wrap gap-2">
            {transcript.words.map((word) => (
              <li
                key={word.text}
                className="rounded-full bg-surface-yellow px-3 py-1 text-sm font-medium text-ink"
              >
                {word.text}
                {/* The count is the reason the word is here at all, so it is shown, quietly. */}
                <span className="ml-1 text-xs font-normal text-yellow-dark tabular-nums">
                  ×{word.count}
                </span>
              </li>
            ))}
          </ul>

          {transcript.phrases.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {transcript.phrases.map((phrase) => (
                <li
                  key={phrase.text}
                  className="rounded-full border border-hairline-strong px-3 py-1 text-sm text-charcoal"
                >
                  {phrase.text}
                  <span className="ml-1 text-xs text-mist tabular-nums">×{phrase.count}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="mb-2 mt-6 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-faint">字幕</h2>
        <button
          onClick={() => setFollowing((v) => !v)}
          className="min-h-tap text-xs text-brand-blue"
        >
          {following ? "停止跟随" : "跟随播放"}
        </button>
      </div>

      <ol
        ref={list}
        // Scrolling by hand means the parent is looking for a line, and having it yanked back
        // two seconds later is the most annoying thing a panel like this can do.
        onTouchStart={() => setFollowing(false)}
        onWheel={() => setFollowing(false)}
        className="max-h-[40vh] overflow-y-auto rounded-xl bg-surface-soft p-2"
      >
        {cues.map((cue, i) => (
          <li key={`${cue.startSeconds}-${i}`}>
            <button
              onClick={() => {
                if (!player) return;
                player.currentTime = cue.startSeconds;
                // Tapping a line is asking to hear it, not just to move the playhead.
                if (player.paused) void player.play().catch(() => {});
                setFollowing(true);
              }}
              className={`flex w-full items-baseline gap-3 rounded-lg px-2 py-1.5 text-left text-sm leading-relaxed ${
                i === active ? "bg-canvas font-medium text-ink" : "text-charcoal"
              }`}
            >
              <span className="shrink-0 text-xs text-mist tabular-nums">
                {formatDuration(cue.startSeconds)}
              </span>
              <span className="min-w-0">{cue.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
