import { useCallback, useEffect, useRef, useState } from "react";
import { watchThresholdSeconds, type Progress, type Video } from "@kel/shared";
import { api } from "./api.js";

/** A jump bigger than this between two `timeupdate` events is a seek, not watching. */
const SEEK_GAP_SECONDS = 2;
/** Back to the very start counts as asking for it again. */
const RESTART_SECONDS = 1.5;

export interface WatchTracker {
  /** Attach to the `<video>`. */
  ref: React.RefCallback<HTMLVideoElement>;
  /** Seconds genuinely played since this Watch began. */
  secondsWatched: number;
  /** True once this playback has been recorded as a Watch. */
  counted: boolean;
}

/**
 * Turn playback into Watches.
 *
 * A Watch is 30 seconds or 40% of the Video, whichever comes first — and it has to be *watched*
 * time, so seeks are excluded by ignoring any jump between events. Playing it again from the
 * start is a new Watch on purpose: a toddler asking for the same song a third time is the exact
 * signal this app exists to capture, and treating it as one long session would throw that away.
 *
 * `enabled` is false during a Preview, in which case nothing is ever sent.
 */
export function useWatchTracker(
  video: Video | undefined,
  enabled: boolean,
  onCounted: (progress: Progress) => void,
): WatchTracker {
  const [secondsWatched, setSecondsWatched] = useState(0);
  const [counted, setCounted] = useState(false);

  const accumulated = useRef(0);
  const lastTime = useRef(0);
  const sending = useRef(false);
  const countedRef = useRef(false);
  // State, not a ref: the listeners have to be re-attached when the element itself changes, and
  // a ref assignment is invisible to effects.
  const [element, setElement] = useState<HTMLVideoElement | null>(null);

  const videoId = video?.id;
  const threshold = watchThresholdSeconds(video?.durationSeconds ?? null);

  // Held in a ref so the listeners below are attached once per Video rather than re-attached on
  // every render — `secondsWatched` changes four times a second while playing, and tearing the
  // listeners down that often is how a `timeupdate` goes missing.
  const notify = useRef(onCounted);
  notify.current = onCounted;

  // A different Video in the same player element starts from nothing.
  useEffect(() => {
    accumulated.current = 0;
    lastTime.current = 0;
    countedRef.current = false;
    setSecondsWatched(0);
    setCounted(false);
  }, [videoId]);

  const restart = useCallback(() => {
    accumulated.current = 0;
    countedRef.current = false;
    setSecondsWatched(0);
    setCounted(false);
  }, []);

  const ref = useCallback<React.RefCallback<HTMLVideoElement>>((el) => {
    setElement(el);
  }, []);

  useEffect(() => {
    const el = element;
    if (!el || !videoId) return;

    const onTimeUpdate = () => {
      const now = el.currentTime;
      const delta = now - lastTime.current;
      lastTime.current = now;

      // Only forward, only real-time-sized steps: a seek earns no credit either way.
      if (delta <= 0 || delta > SEEK_GAP_SECONDS) {
        // A loop wraps round by seeking to the start rather than ending, and on an AirPlay target
        // that arrives as a bare jump backwards to zero — same replay, so count it as one.
        if (now < RESTART_SECONDS && accumulated.current > 0) restart();
        return;
      }

      accumulated.current += delta;
      setSecondsWatched(accumulated.current);

      if (countedRef.current || !enabled || accumulated.current < threshold) return;

      countedRef.current = true;
      setCounted(true);
      if (sending.current) return;
      sending.current = true;
      void api
        .recordWatch(videoId, accumulated.current)
        .then((res) => {
          if (res.counted) notify.current(res.progress);
        })
        .catch(() => {
          // Losing one Watch to a dropped connection is not worth an error message in front of
          // a child mid-song; the next playthrough will record one.
          countedRef.current = false;
          setCounted(false);
        })
        .finally(() => {
          sending.current = false;
        });
    };

    const onSeeked = () => {
      lastTime.current = el.currentTime;
      // Dragged back to the beginning: that is a new Watch, not more of the old one.
      if (el.currentTime < RESTART_SECONDS && accumulated.current > 0) restart();
    };

    const onEnded = () => restart();
    const onPlay = () => {
      lastTime.current = el.currentTime;
      if (el.currentTime < RESTART_SECONDS && countedRef.current) restart();
    };

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("ended", onEnded);
    el.addEventListener("play", onPlay);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("play", onPlay);
    };
  }, [element, videoId, enabled, threshold, restart]);

  return { ref, secondsWatched, counted };
}
