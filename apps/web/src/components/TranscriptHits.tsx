import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Video } from "@kel/shared";
import { api } from "../api.js";

/** Long enough that the parent has stopped typing, short enough not to feel laggy. */
const DEBOUNCE_MS = 350;
/** Below this a query matches half the library; the local filter already handles it. */
const MIN_QUERY = 2;

/**
 * "Also found in the lyrics of…"
 *
 * Everything else on the library screen filters what is already in the browser. This is the one
 * thing that cannot: Transcripts are too big to ship up front (routes/library.ts), so finding a
 * word that a Video says only once means asking the server. It shows up *below* the local
 * results rather than replacing them, because the local list arrives instantly and this does not.
 */
export function TranscriptHits({
  query,
  videos,
  exclude,
}: {
  query: string;
  videos: Video[];
  /** Videos already shown by the local filter — repeating them would just look like a bug. */
  exclude: Set<string>;
}) {
  const [hits, setHits] = useState<{ videoId: string; snippet: string }[]>([]);
  const [truncated, setTruncated] = useState(false);
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < MIN_QUERY) {
      setHits([]);
      setTruncated(false);
      return;
    }

    let live = true;
    const timer = setTimeout(() => {
      api
        .searchTranscripts(trimmed)
        .then((res) => {
          if (!live) return;
          setHits(res.hits);
          setTruncated(res.truncated);
        })
        // A failed supplementary search is not worth saying anything about: the local results
        // are on screen and still correct.
        .catch(() => {
          if (live) setHits([]);
        });
    }, DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [trimmed]);

  const byId = new Map(videos.map((v) => [v.id, v]));
  const extra = hits
    .filter((h) => !exclude.has(h.videoId))
    .map((h) => ({ hit: h, video: byId.get(h.videoId) }))
    .filter((row): row is { hit: typeof row.hit; video: Video } => row.video !== undefined);

  if (extra.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-medium text-faint">字幕里也提到了</h2>
      <ul className="space-y-2">
        {extra.map(({ hit, video }) => (
          <li key={video.id}>
            <Link
              to={`/v/${video.id}`}
              className="block rounded-xl bg-surface-soft px-4 py-3 active:bg-surface"
            >
              <p className="text-sm font-medium leading-snug text-ink">{video.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-stone">{hit.snippet}</p>
            </Link>
          </li>
        ))}
      </ul>
      {truncated && (
        <p className="mt-2 text-xs text-mist">还有更多，说得更具体一点会更准。</p>
      )}
    </section>
  );
}
