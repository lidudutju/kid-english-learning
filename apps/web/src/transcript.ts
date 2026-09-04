import { useEffect, useState } from "react";
import type { TranscriptCue, TranscriptResponse } from "@kel/shared";
import { api, ApiError } from "./api.js";

/**
 * Transcripts already fetched, kept for the life of the tab.
 *
 * A Transcript is written once by the Agent and never edited, so there is no staleness to worry
 * about — and the access pattern is a parent going back and forth between the library and three
 * or four Videos all evening. Without this, every return trip re-downloads the same cues.
 */
const cache = new Map<string, TranscriptResponse>();

export interface TranscriptState {
  transcript: TranscriptResponse | null;
  loading: boolean;
  /** Set only for real failures; a Video with no captions is not an error. */
  error: string | null;
}

export function useTranscript(
  videoId: string | undefined,
  hasTranscript: boolean,
): TranscriptState {
  const [state, setState] = useState<TranscriptState>(() => ({
    transcript: videoId ? (cache.get(videoId) ?? null) : null,
    loading: false,
    error: null,
  }));

  useEffect(() => {
    if (!videoId || !hasTranscript) {
      setState({ transcript: null, loading: false, error: null });
      return;
    }

    const cached = cache.get(videoId);
    if (cached) {
      setState({ transcript: cached, loading: false, error: null });
      return;
    }

    // The Video may well be playing by the time this resolves, and switching Videos mid-flight
    // must not drop the wrong cues into the panel.
    let live = true;
    setState({ transcript: null, loading: true, error: null });
    api
      .transcript(videoId)
      .then((transcript) => {
        cache.set(videoId, transcript);
        if (live) setState({ transcript, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!live) return;
        // 404 means the manifest and the Transcript table disagree — possible for a few seconds
        // around ingest. Not worth an error message; the next poll fixes it.
        const missing = err instanceof ApiError && err.status === 404;
        setState({
          transcript: null,
          loading: false,
          error: missing ? null : "字幕加载失败",
        });
      });

    return () => {
      live = false;
    };
  }, [videoId, hasTranscript]);

  return state;
}

/**
 * Which cue is on screen at `seconds`, or -1.
 *
 * A linear scan from the start, not a binary search: cues are in order and there are a few
 * hundred of them, and this runs on `timeupdate` — four times a second, against an array that
 * fits in cache. A binary search here would be a cleverer way to do the same nothing.
 */
export function activeCueIndex(cues: TranscriptCue[], seconds: number): number {
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    if (seconds < cue.startSeconds) return -1;
    if (seconds <= cue.endSeconds) return i;
  }
  return -1;
}
