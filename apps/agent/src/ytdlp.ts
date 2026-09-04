import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { focusFrom, parseVtt, type TranscriptKind, type TranscriptCue } from "@kel/shared";
import type { Config } from "./config.js";
import { run } from "./proc.js";

export interface DownloadedTranscript {
  lang: string;
  kind: TranscriptKind;
  cues: TranscriptCue[];
}

export interface DownloadResult {
  /** Path to the file yt-dlp produced. */
  file: string;
  /** YouTube's own thumbnail, already converted to jpg, if we got one. */
  thumbnail: string | null;
  title: string;
  channel: string | null;
  /** yt-dlp's own duration, used as a fallback when ffprobe cannot tell us. */
  durationSeconds: number | null;
  /** `YYYY-MM-DD`, from yt-dlp's `upload_date`. */
  publishedAt: string | null;
  /** English captions, if this video had any. Null is the normal case for a lot of rhymes. */
  transcript: DownloadedTranscript | null;
}

export interface DownloadProgress {
  percent: number | null;
  detail: string;
}

/**
 * Prefer H.264 video and AAC audio at the source, so the normalise step can usually be a
 * stream copy instead of a re-encode. YouTube's better-looking formats are VP9 and AV1, which
 * an Apple TV or an older Xiaomi TV will refuse — and re-encoding 1080p on a laptop is minutes
 * of fan noise per video. The trailing fallbacks accept anything rather than fail outright.
 */
function formatSelector(maxHeight: number): string {
  return [
    `bv*[vcodec^=avc1][height<=?${maxHeight}]+ba[acodec^=mp4a]`,
    `bv*[vcodec^=avc1][height<=?${maxHeight}]+ba`,
    `b[ext=mp4][height<=?${maxHeight}]`,
    `bv*[height<=?${maxHeight}]+ba`,
    "b",
  ].join("/");
}

/** yt-dlp's own words for causes that retrying will never fix. */
const PERMANENT_PATTERNS = [
  /video unavailable/i,
  // Not the same string as the one above, and this is the wording a region-blocked video
  // actually produces — without it such a link burns every attempt before reporting.
  /video is not available/i,
  /private video/i,
  /has been removed/i,
  /members[- ]only/i,
  /is not available in your country/i,
  /this video is age[- ]restricted/i,
  /sign in to confirm your age/i,
  /copyright/i,
];

export function isPermanentFailure(message: string): boolean {
  return PERMANENT_PATTERNS.some((p) => p.test(message));
}

export async function download(
  config: Config,
  url: string,
  outputDir: string,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<DownloadResult> {
  const args = [
    "--no-playlist",
    "--no-color",
    "--newline",
    "--no-progress",
    "--restrict-filenames",
    "-f",
    formatSelector(config.maxHeight),
    "--merge-output-format",
    "mp4",
    // Deterministic merge output, so re-downloading the same video produces the same Source
    // Digest instead of a new one every time.
    "--postprocessor-args",
    "Merger:-fflags +bitexact",
    "--write-info-json",
    "--write-thumbnail",
    "--convert-thumbnails",
    "jpg",
    "--progress-template",
    "KELPROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "-o",
    join(outputDir, "source.%(ext)s"),
    url,
  ];

  if (config.cookiesFile) args.push("--cookies", config.cookiesFile);

  let lastError = "";
  await run(config.ytDlp, args, {
    signal,
    onStdout: (line) => {
      if (line.startsWith("KELPROG|")) {
        const [, percentStr, speed, eta] = line.split("|");
        const percent = Number.parseFloat((percentStr ?? "").replace("%", "").trim());
        onProgress({
          percent: Number.isFinite(percent) ? percent : null,
          detail: [speed?.trim(), eta?.trim() && `剩 ${eta.trim()}`].filter(Boolean).join(" · "),
        });
      }
    },
    onStderr: (line) => {
      if (/^(ERROR|WARNING)/i.test(line)) lastError = line;
    },
  }).catch((err) => {
    const detail = lastError || (err instanceof Error ? err.message : String(err));
    throw new Error(detail);
  });

  await fetchCaptions(config, url, outputDir, signal);

  return readOutputs(outputDir);
}

/**
 * The English caption tracks, if this video has any, in a pass of their own.
 *
 * These flags used to ride along with the video download, and that was a real bug: a caption
 * fetch that failed took the whole job with it, throwing away a video that had already finished
 * downloading. `nFxAiWkSePk` is what proved it — `ERROR: Unable to download video subtitles for
 * 'en-hi': HTTP Error 429: Too Many Requests` and the ingest was over. Captions are a
 * nice-to-have, exactly like the thumbnail, so the whole invocation is wrapped and forgotten:
 * a Video with no Transcript still plays.
 *
 * The lang list is spelled out rather than globbed for the same reason. `en.*` reads like
 * "English", but YouTube publishes an auto-translation into English from every language it can
 * hear, named `en-hi`, `en-pt`, `en-vi` — and `en-en`, English translated into English. On that
 * video the glob matched seven tracks, so every ingest opened seven caption requests to fetch
 * the two worth having, which is how the rate limit got tripped in the first place. These four
 * are exactly the ones readTranscript() knows how to score, and no other language is asked for
 * at all: the Learner is learning English, and a Spanish track would be counted as Focus Words.
 */
async function fetchCaptions(
  config: Config,
  url: string,
  outputDir: string,
  signal: AbortSignal,
): Promise<void> {
  const args = [
    "--no-playlist",
    "--no-color",
    "--no-progress",
    "--skip-download",
    // Author-written captions when they exist; auto-generated otherwise, which for songs for
    // children is most of the time.
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en,en-orig,en-US,en-GB",
    "--convert-subs",
    "vtt",
    "-o",
    join(outputDir, "source.%(ext)s"),
    url,
  ];

  if (config.cookiesFile) args.push("--cookies", config.cookiesFile);

  try {
    await run(config.ytDlp, args, { signal });
  } catch (err) {
    // One exception to swallowing: a cancelled job must stay cancelled, or the pipeline carries
    // on transcoding and uploading something nobody is waiting for any more.
    if (signal.aborted) throw err;
    // Otherwise deliberately silent about the cause. Nothing downstream can act on it, and the
    // person waiting is told what they need to know by the Transcript panel not appearing.
  }
}

/**
 * yt-dlp names files after the video, and `--restrict-filenames` does not make the extension
 * predictable, so find what it actually wrote rather than guessing.
 */
async function readOutputs(outputDir: string): Promise<DownloadResult> {
  const files = await readdir(outputDir);

  const media = files.find((f) => /^source\.(mp4|mkv|webm|mov|m4v)$/i.test(f));
  if (!media) {
    throw new Error(`yt-dlp 没有产出视频文件，目录里只有：${files.join(", ") || "（空）"}`);
  }

  const infoName = files.find((f) => f.endsWith(".info.json"));
  const thumbName = files.find((f) => /\.jpg$/i.test(f));

  let info: Record<string, unknown> = {};
  if (infoName) {
    try {
      info = JSON.parse(await readFile(join(outputDir, infoName), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // Metadata is a nice-to-have; a Video with a poor title still plays.
    }
  }

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const num = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : null);

  const uploadDate = str(info.upload_date); // YYYYMMDD
  const publishedAt =
    uploadDate && /^\d{8}$/.test(uploadDate)
      ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
      : null;

  return {
    file: join(outputDir, media),
    thumbnail: thumbName ? join(outputDir, thumbName) : null,
    title: str(info.title) ?? "未命名视频",
    channel: str(info.uploader) ?? str(info.channel),
    durationSeconds: num(info.duration),
    publishedAt,
    transcript: await readTranscript(outputDir, files, info),
  };
}

/**
 * Pick one caption track and parse it.
 *
 * Four English variants are asked for and yt-dlp writes however many exist — usually two; only one
 * Transcript is stored, so the choice is made here rather than left to whichever filename sorts
 * first.
 */
async function readTranscript(
  outputDir: string,
  files: string[],
  info: Record<string, unknown>,
): Promise<DownloadedTranscript | null> {
  // `source.en.vtt`, `source.en-GB.vtt`, `source.en-orig.vtt`.
  const tracks = files
    .map((name) => /^source\.([\w-]+)\.vtt$/i.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[0], lang: m[1]! }));

  if (tracks.length === 0) return null;

  // Which langs the *author* wrote, as opposed to what a machine transcribed. Read from
  // info.json because the filenames are identical either way.
  const manualLangs = new Set(Object.keys((info.subtitles as object | undefined) ?? {}));

  const score = (lang: string) => {
    let s = 0;
    // Written captions are the point: on a song, they are the lyrics, and a machine's guess at
    // sung English is the thing most likely to embarrass the Focus Words.
    if (manualLangs.has(lang)) s += 100;
    // `en-orig` is YouTube's marker for "the original language track", which for a
    // machine-transcribed video is the transcription rather than a translation of it.
    if (/^en$/i.test(lang)) s += 10;
    else if (/^en-orig$/i.test(lang)) s += 8;
    else if (/^en-(US|GB)$/i.test(lang)) s += 6;
    return s;
  };

  const best = tracks.reduce((a, b) => (score(b.lang) > score(a.lang) ? b : a));

  try {
    const cues = parseVtt(await readFile(join(outputDir, best.name), "utf8"));
    if (cues.length === 0) return null;
    return {
      lang: best.lang,
      kind: manualLangs.has(best.lang) ? "manual" : "auto",
      cues,
    };
  } catch {
    // Same judgement as the thumbnail: a Transcript is worth having, not worth failing over.
    return null;
  }
}

/** Focus Words, counted here because the Worker has no CPU budget for it (schema.ts explains). */
export function transcriptPayload(transcript: DownloadedTranscript) {
  const focus = focusFrom(transcript.cues);
  return { ...transcript, words: focus.words, phrases: focus.phrases };
}
