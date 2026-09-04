/**
 * Turning whatever the parent pasted into a Source Key.
 *
 * A Source Key is the dedup identity, so this has to be aggressively normalising:
 * `youtu.be/X`, `watch?v=X&t=45s&list=...`, `music.youtube.com`, `/shorts/X`, `/embed/X`
 * and a bare id must all collapse to exactly `youtube:X`.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
]);

/** First path segment for URL shapes that carry the id in the path, not `?v=`. */
const PATH_PREFIXES = ["embed", "shorts", "live", "v"];

export type YoutubeParse =
  | { ok: true; videoId: string; sourceKey: string; canonicalUrl: string }
  | { ok: false; reason: YoutubeParseError };

export type YoutubeParseError =
  | "empty"
  | "not-a-url"
  | "not-youtube"
  | "playlist-only"
  | "no-video-id";

export function parseYoutubeInput(raw: string): YoutubeParse {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "empty" };

  // A bare id pasted on its own is common enough to accept.
  if (VIDEO_ID.test(input)) return ok(input);

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { ok: false, reason: "not-a-url" };
  }

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return { ok: false, reason: "not-youtube" };

  const segments = url.pathname.split("/").filter(Boolean);

  // youtu.be/<id>
  if (host.endsWith("youtu.be")) {
    const id = segments[0];
    return id && VIDEO_ID.test(id) ? ok(id) : { ok: false, reason: "no-video-id" };
  }

  // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
  const [first, second] = segments;
  if (first && PATH_PREFIXES.includes(first.toLowerCase())) {
    return second && VIDEO_ID.test(second)
      ? ok(second)
      : { ok: false, reason: "no-video-id" };
  }

  const v = url.searchParams.get("v");
  if (v && VIDEO_ID.test(v)) return ok(v);

  // A playlist link with no `v=` is a different feature; refuse it clearly rather
  // than silently importing the first video.
  if (url.searchParams.has("list")) return { ok: false, reason: "playlist-only" };

  return { ok: false, reason: "no-video-id" };
}

function ok(videoId: string): YoutubeParse {
  return {
    ok: true,
    videoId,
    sourceKey: `youtube:${videoId}`,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export const YOUTUBE_PARSE_MESSAGE: Record<YoutubeParseError, string> = {
  empty: "请粘贴一个 YouTube 链接",
  "not-a-url": "这看起来不是一个链接",
  "not-youtube": "只支持 YouTube 链接",
  "playlist-only": "这是播放列表链接，请粘贴单个视频的链接",
  "no-video-id": "链接里找不到视频 ID",
};
