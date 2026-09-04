import {
  MAX_UPLOAD_BYTES,
  Sha256,
  uploadExtension,
  UPLOAD_EXTENSIONS,
  UPLOAD_PART_BYTES,
} from "@kel/shared";
import { api, ApiError } from "./api.js";

export type UploadPhase = "hashing" | "uploading" | "finishing";

export interface UploadState {
  phase: UploadPhase;
  /** 0-100 within the current phase. Two phases, two bars — one fake bar would be worse. */
  percent: number;
}

export const UPLOAD_PHASE_LABEL: Record<UploadPhase, string> = {
  hashing: "正在检查这个文件",
  uploading: "正在上传",
  finishing: "正在收尾",
};

/** How many times one part is retried before the whole upload gives up. */
const PART_ATTEMPTS = 3;

export function checkFile(file: File): string | null {
  if (!uploadExtension(file.name)) {
    return `只收这些格式：${UPLOAD_EXTENSIONS.join("、")}`;
  }
  if (file.size === 0) return "这个文件是空的";
  if (file.size > MAX_UPLOAD_BYTES) {
    return `文件太大了（${(file.size / 1024 / 1024 / 1024).toFixed(1)} GB），上限 2 GB`;
  }
  return null;
}

/**
 * Hash the file in the browser, then push it up in parts.
 *
 * The hash comes first and is the point: it is the Source Digest, so a Duplicate is refused
 * before anything is uploaded rather than after (docs/adr/0004). The file is read twice — once
 * to hash, once to send — because holding a whole video in memory on a phone is the one thing
 * this must not do.
 */
export async function uploadVideo(
  file: File,
  title: string | null,
  onState: (state: UploadState) => void,
): Promise<{ jobId: string }> {
  // Read size for hashing only — the part size that matters is the one the Worker hands back,
  // because R2 requires every part to be exactly that big.
  const hasher = new Sha256();
  for (let offset = 0; offset < file.size; offset += UPLOAD_PART_BYTES) {
    const slice = await file.slice(offset, offset + UPLOAD_PART_BYTES).arrayBuffer();
    hasher.update(new Uint8Array(slice));
    onState({ phase: "hashing", percent: ((offset + slice.byteLength) / file.size) * 100 });
  }
  const sourceDigest = hasher.digestHex();

  const prepared = await api.prepareUpload({
    sourceDigest,
    filename: file.name,
    bytes: file.size,
    title,
  });

  const { jobId, partBytes, partCount } = prepared;
  const parts: { partNumber: number; etag: string }[] = [];

  try {
    for (let index = 0; index < partCount; index++) {
      const start = index * partBytes;
      const chunk = file.slice(start, Math.min(start + partBytes, file.size));
      parts.push({ partNumber: index + 1, etag: await sendPart(jobId, index + 1, chunk) });
      onState({ phase: "uploading", percent: ((index + 1) / partCount) * 100 });
    }

    onState({ phase: "finishing", percent: 100 });
    await api.completeUpload(jobId, parts);
  } catch (err) {
    // Leave nothing half-arrived: the abort is what actually frees the parts already in R2,
    // and it releases this file's Source Key so picking it again works.
    await api.abortUpload(jobId).catch(() => {});
    throw err;
  }

  return { jobId };
}

/**
 * One part, with retries.
 *
 * A phone on wifi at the edge of the house drops a request now and then, and losing a 200 MB
 * upload to one of them would be miserable. A duplicate part number simply overwrites, so
 * retrying is safe.
 */
async function sendPart(jobId: string, partNumber: number, chunk: Blob): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    try {
      return await api.uploadPart(jobId, partNumber, chunk);
    } catch (err) {
      // The job is gone, or the session is: no number of retries will bring either back.
      if (err instanceof ApiError && (err.status === 409 || err.status === 400)) throw err;
      lastError = err;
      if (attempt < PART_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`第 ${partNumber} 块传不上去`);
}
