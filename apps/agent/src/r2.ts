import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Config } from "./config.js";

/**
 * R2's S3 API rejects the flexible checksum headers that recent AWS SDK versions send by
 * default, so both are forced back to WHEN_REQUIRED. Without this, uploads fail with an
 * opaque signature error on SDK >= 3.729.
 */
export function makeClient(config: Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/**
 * Playable keys are random per Video and never reused, so the object at a key can never
 * change — which makes `immutable` honest and lets Cloudflare's cache hold it for a year.
 * That cache hit is where the playback speed actually comes from.
 */
const IMMUTABLE = "public, max-age=31536000, immutable";

export async function uploadFile(
  client: S3Client,
  config: Config,
  file: string,
  key: string,
  contentType: string,
  onProgress?: (percent: number) => void,
): Promise<number> {
  const { size } = await stat(file);

  const upload = new Upload({
    client,
    params: {
      Bucket: config.r2Bucket,
      Key: key,
      Body: createReadStream(file),
      ContentType: contentType,
      CacheControl: IMMUTABLE,
    },
    // 16 MB parts, three in flight: enough to saturate a home upstream without holding the
    // whole file in memory.
    partSize: 16 * 1024 * 1024,
    queueSize: 3,
    leavePartsOnError: false,
  });

  if (onProgress) {
    upload.on("httpUploadProgress", (p) => {
      const total = p.total ?? size;
      if (total > 0 && p.loaded !== undefined) {
        onProgress(Math.min(100, (p.loaded / total) * 100));
      }
    });
  }

  await upload.done();
  return size;
}
