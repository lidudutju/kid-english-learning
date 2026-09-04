import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { run } from "./proc.js";

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

  return readOutputs(outputDir);
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
  };
}
