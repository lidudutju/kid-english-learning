import type { Config } from "./config.js";
import { run } from "./proc.js";

export interface Probe {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Bits per second over the whole file — what the phone's connection has to keep up with. */
  bitrate: number | null;
  /** True when the `moov` atom is already at the front of the file. */
  faststart: boolean;
}

export async function probe(config: Config, file: string): Promise<Probe> {
  const { stdout } = await run(config.ffprobe, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; tags?: Record<string, string> };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number.parseFloat(parsed.format?.duration ?? "");

  return {
    durationSeconds: Number.isFinite(duration) ? duration : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    faststart: await hasFaststart(file),
  };
}

/**
 * Whether `moov` precedes `mdat`.
 *
 * This is the whole reason playback feels instant or doesn't: with `moov` at the end, Safari
 * must fetch the tail of the file before it can render frame one, which on a phone over
 * cellular is a visible multi-second stall. Read the first few boxes rather than trusting the
 * source to have been muxed sensibly.
 */
async function hasFaststart(file: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  const handle = await open(file, "r");
  try {
    let offset = 0;
    for (let i = 0; i < 16; i++) {
      const header = Buffer.alloc(8);
      const { bytesRead } = await handle.read(header, 0, 8, offset);
      if (bytesRead < 8) return false;

      let size = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;

      if (size === 1) {
        // 64-bit extended size follows the header.
        const ext = Buffer.alloc(8);
        await handle.read(ext, 0, 8, offset + 8);
        size = Number(ext.readBigUInt64BE(0));
      } else if (size === 0) {
        return false; // Box extends to EOF; nothing left to find.
      }
      if (size < 8) return false;
      offset += size;
    }
    return false;
  } finally {
    await handle.close();
  }
}

/** Cheap enough to copy, and accepted by every target: an iPhone, Safari, and a TV. */
function isAlreadyCompatible(p: Probe): boolean {
  return p.videoCodec === "h264" && (p.audioCodec === "aac" || p.audioCodec === null);
}

/**
 * ffmpeg's own words for "this is not a video I can work with".
 *
 * Only reachable through manual upload — yt-dlp never hands over a text file that has been
 * renamed to .mp4, or a half-copied AirDrop. Retrying any of these three times only makes the
 * parent wait longer for the same answer.
 */
const UNUSABLE_PATTERNS = [
  /invalid data found when processing input/i,
  /moov atom not found/i,
  /does not contain any stream/i,
  /unknown format/i,
  /no such file or directory/i,
];

export function isUnusableMedia(message: string): boolean {
  return UNUSABLE_PATTERNS.some((p) => p.test(message));
}

export interface NormalizeResult {
  /** True when we re-encoded rather than remuxed — worth knowing, it costs minutes. */
  reencoded: boolean;
}

/**
 * Produce the Playable: one MP4, H.264 + AAC, `moov` at the front.
 *
 * A stream copy when the source already has the right codecs (seconds), a real encode when it
 * does not (minutes). Either way the output is uniform, which is the point — the alternative is
 * discovering on casting day that a third of the library will not play on the TV.
 */
export async function normalize(
  config: Config,
  input: string,
  output: string,
  p: Probe,
  onProgress: (percent: number | null) => void,
  signal: AbortSignal,
): Promise<NormalizeResult> {
  const reencoded = !isAlreadyCompatible(p);

  const codecArgs = reencoded
    ? [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "21",
        "-profile:v",
        "high",
        "-level",
        "4.0",
        // Required for H.264 in MP4 when the source has odd dimensions.
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
      ]
    : ["-c", "copy"];

  const totalUs = (p.durationSeconds ?? 0) * 1_000_000;

  await run(
    config.ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      input,
      // One video track and, if there is one, one audio track. An uploaded MKV can carry
      // subtitle and attachment streams that MP4 has nowhere to put, and a stream copy of the
      // lot fails on them — a phone recording of the child singing is a normal Source here.
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      ...codecArgs,
      "-movflags",
      "+faststart",
      "-map_metadata",
      "-1",
      "-progress",
      "pipe:1",
      "-nostats",
      output,
    ],
    {
      signal,
      onStdout: (line) => {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (!match || totalUs <= 0) return;
        onProgress(Math.min(100, (Number(match[1]) / totalUs) * 100));
      },
    },
  );

  return { reencoded };
}

/**
 * Shrink a thumbnail before it ever reaches R2.
 *
 * YouTube's own artwork is up to 1280px and ~100 KB. The library list shows every Video at
 * once on a phone, so a few hundred of those is megabytes of images for a grid of 160px
 * tiles — downscale once here rather than making the phone do it on every visit.
 */
export async function downscaleImage(
  config: Config,
  input: string,
  output: string,
): Promise<void> {
  await run(config.ffmpeg, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-vf",
    "scale=480:-2",
    "-q:v",
    "5",
    output,
  ]);
}

/** Frame grab, used only when YouTube gave us no thumbnail of its own. */
export async function extractThumbnail(
  config: Config,
  input: string,
  output: string,
  durationSeconds: number | null,
): Promise<void> {
  // 10% in — far enough past title cards and black frames to show something recognisable.
  const at = durationSeconds && durationSeconds > 4 ? durationSeconds * 0.1 : 1;
  await run(config.ffmpeg, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-ss",
    at.toFixed(2),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    "scale=640:-2",
    "-q:v",
    "4",
    output,
  ]);
}
