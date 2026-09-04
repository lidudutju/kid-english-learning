import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import type { AgentClaimJob, JobStatus } from "@kel/shared";
import type { S3Client } from "@aws-sdk/client-s3";
import { Api, LeaseLostError } from "./api.js";
import type { Config } from "./config.js";
import {
  downscaleImage,
  extractThumbnail,
  isUnusableMedia,
  normalize,
  probe,
} from "./ffmpeg.js";
import { uploadFile } from "./r2.js";
import { download, isPermanentFailure } from "./ytdlp.js";

type ReportableStatus = Extract<JobStatus, "downloading" | "normalizing" | "uploading">;

/**
 * Keeps the Worker informed and the lease alive.
 *
 * The lease is what stops a crashed Agent from stranding a job, so it has to be renewed even
 * during stretches with no progress output at all — a stream-copy remux of a long video emits
 * nothing for a while. Hence a timer that re-sends the last known state rather than only
 * sending when something changes.
 */
class Reporter {
  private status: ReportableStatus = "downloading";
  private percent: number | null = null;
  private detail: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(
    private readonly api: Api,
    private readonly jobId: string,
    private readonly onLeaseLost: () => void,
  ) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.flush(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  set(status: ReportableStatus, percent: number | null, detail?: string | null): void {
    const changedStage = status !== this.status;
    this.status = status;
    this.percent = percent;
    if (detail !== undefined) this.detail = detail;
    if (changedStage) void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.inFlight) return; // A slow uplink must not queue up a backlog of reports.
    this.inFlight = true;
    try {
      await this.api.progress(this.jobId, this.status, this.percent, this.detail);
    } catch (err) {
      if (err instanceof LeaseLostError) {
        this.stop();
        this.onLeaseLost();
      }
      // Anything else is a transient network problem; the next tick retries.
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * The Source Digest.
 *
 * Hashed over yt-dlp's output — the closest reproducible thing to "the bytes as they arrived"
 * — and specifically *not* over the Playable, which is re-derived and differs byte for byte
 * every time. For YouTube the Source Key does the real duplicate blocking; this is the
 * backstop, and it becomes load-bearing for manual uploads, where the browser hashes the file
 * the parent actually picked.
 */
async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

export interface ProcessOutcome {
  status: "done" | "failed" | "abandoned";
  message?: string;
}

/**
 * What the first half of the pipeline produces, whichever Source it came from.
 *
 * A YouTube link and an uploaded file differ only in how the bytes and the metadata arrive;
 * everything after this point — digest, normalise, thumbnail, upload, register — is identical,
 * which is what docs/adr/0001 means by one state machine covering both.
 */
interface SourceMaterial {
  file: string;
  thumbnail: string | null;
  title: string;
  channel: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
}

async function fetchSource(
  config: Config,
  api: Api,
  job: AgentClaimJob,
  dir: string,
  reporter: Reporter,
  signal: AbortSignal,
): Promise<SourceMaterial> {
  if (job.sourceKind === "upload") {
    reporter.set("downloading", 0, "从 Cloudflare 取原片");
    const file = join(dir, "source");
    await api.fetchOriginal(
      job.id,
      file,
      (percent, detail) => reporter.set("downloading", percent, detail),
      signal,
    );
    return {
      file,
      // Nothing came with the file, so the thumbnail is a frame grab further down.
      thumbnail: null,
      title: job.title ?? "未命名视频",
      channel: null,
      durationSeconds: null,
      publishedAt: null,
    };
  }

  if (!job.sourceUrl) throw new Error("任务没有来源链接");
  reporter.set("downloading", 0, "正在连接 YouTube");

  const downloaded = await download(
    config,
    job.sourceUrl,
    dir,
    ({ percent, detail }) => reporter.set("downloading", percent, detail || null),
    signal,
  );
  return downloaded;
}

export async function processJob(
  config: Config,
  api: Api,
  s3: S3Client,
  job: AgentClaimJob,
  log: (message: string) => void,
): Promise<ProcessOutcome> {
  const dir = join(config.workDir, job.id);
  const abort = new AbortController();
  const reporter = new Reporter(api, job.id, () => {
    log(`任务 ${job.id} 的租约被收回了，放弃`);
    abort.abort();
  });

  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    /* ------------------------------------------------------------------ source */
    reporter.start(config.heartbeatMs);

    const source = await fetchSource(config, api, job, dir, reporter, abort.signal);
    if (abort.signal.aborted) return { status: "abandoned" };
    log(`取到源文件：${source.title}`);

    /* ------------------------------------------------------ digest and probing */
    reporter.set("normalizing", 0, "正在校验");
    const sourceDigest = await sha256File(source.file);

    /**
     * An upload arrives with its digest already fixed by the browser. Checking it here, rather
     * than letting the Worker notice at register time, is the difference between "fetch it
     * again" and "the whole Ingest failed": the original is still sitting in the private
     * bucket, so a truncated fetch is worth exactly one retry.
     */
    if (job.sourceDigest && sourceDigest !== job.sourceDigest) {
      throw new Error("原片没取完整（校验不一致），重新取一次");
    }

    const sourceProbe = await probe(config, source.file);

    /* --------------------------------------------------------------- normalise */
    const playable = join(dir, "playable.mp4");
    const { reencoded } = await normalize(
      config,
      source.file,
      playable,
      sourceProbe,
      (percent) => reporter.set("normalizing", percent),
      abort.signal,
    );
    if (abort.signal.aborted) return { status: "abandoned" };
    reporter.set("normalizing", 100, reencoded ? "重新编码完成" : "封装完成");
    log(reencoded ? "重新编码了（源不是 H.264/AAC）" : "直接封装（源已是 H.264/AAC）");

    // Probe the Playable, not the source: these numbers describe what the browser will get.
    const playableProbe = await probe(config, playable);
    if (!playableProbe.faststart) {
      throw new Error("转码后 moov 仍不在文件开头，播放会卡首帧");
    }

    /* --------------------------------------------------------------- thumbnail */
    const thumb = join(dir, "thumb.jpg");
    let hasThumb = false;
    try {
      if (source.thumbnail) {
        await downscaleImage(config, source.thumbnail, thumb);
      } else {
        await extractThumbnail(config, playable, thumb, playableProbe.durationSeconds);
      }
      hasThumb = true;
    } catch (err) {
      // A missing thumbnail is cosmetic. Failing the whole Ingest over it would not be.
      log(`缩略图失败（不影响播放）：${err instanceof Error ? err.message : String(err)}`);
    }

    /* ------------------------------------------------------------------ upload */
    reporter.set("uploading", 0, "上传到 R2");
    const bytes = await uploadFile(
      s3,
      config,
      playable,
      `${job.assetPrefix}/video.mp4`,
      "video/mp4",
      (percent) => reporter.set("uploading", percent),
    );
    if (hasThumb) {
      await uploadFile(s3, config, thumb, `${job.assetPrefix}/thumb.jpg`, "image/jpeg");
    }
    if (abort.signal.aborted) return { status: "abandoned" };

    /* ---------------------------------------------------------------- register */
    reporter.stop();
    await api.complete(job.id, {
      sourceDigest,
      hasThumb,
      bytes,
      title: source.title,
      channel: source.channel,
      durationSeconds: playableProbe.durationSeconds ?? source.durationSeconds,
      width: playableProbe.width,
      height: playableProbe.height,
      publishedAt: source.publishedAt,
    });

    return { status: "done" };
  } catch (err) {
    reporter.stop();
    if (err instanceof LeaseLostError || abort.signal.aborted) return { status: "abandoned" };

    const message = err instanceof Error ? err.message : String(err);
    // Two families of hopeless cause: a link YouTube will never serve, and a file that is not
    // a video at all. Everything else gets its attempts.
    const retryable = !isPermanentFailure(message) && !isUnusableMedia(message);
    try {
      await api.fail(job.id, message, retryable);
    } catch (reportErr) {
      if (!(reportErr instanceof LeaseLostError)) throw reportErr;
    }
    return { status: "failed", message };
  } finally {
    reporter.stop();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
