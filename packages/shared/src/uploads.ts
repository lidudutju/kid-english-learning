/**
 * Manual upload: the numbers and the identity rules, shared by the browser (which slices the
 * file) and the Worker (which relays the parts into R2). See docs/adr/0004.
 */

/**
 * Part size for the browser → Worker → R2 relay.
 *
 * R2 requires every part except the last to be at least 5 MiB and all of them to be equal, so
 * this is not free to tune. 8 MiB keeps each request comfortably inside a Worker's memory,
 * gives an honest progress bar on a home uplink, and reaches 80 GB before running out of the
 * 10,000-part limit.
 */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/** Well past any nursery rhyme. A file this big is a mistake, and saying so beats an hour of
 * uploading followed by a transcode that never finishes. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** What the Agent's ffmpeg will actually accept as a source container. */
export const UPLOAD_EXTENSIONS = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg"];

export function uploadExtension(filename: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const ext = match?.[1]?.toLowerCase() ?? null;
  return ext && UPLOAD_EXTENSIONS.includes(ext) ? ext : null;
}

/**
 * The Source Key of an upload is its Source Digest.
 *
 * A file has no URL to normalise, so the bytes are the only stable identity it has — which
 * means the two Duplicate checks collapse into one, and it can be made before the upload
 * rather than after.
 */
export function uploadSourceKey(sourceDigest: string): string {
  return `upload:${sourceDigest}`;
}

/** Strip the extension for a default title, so "Baby_Shark_final2.mp4" arrives readable. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "");
  const cleaned = base.replace(/[_+]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "未命名视频";
}

export function partCount(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / UPLOAD_PART_BYTES));
}
