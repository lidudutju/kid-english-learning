import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { agentClaimResponse, type AgentClaimJob, type JobStatus } from "@kel/shared";
import type { Config } from "./config.js";

/** Thrown when the Worker says another Agent now owns this job. Abandon, do not retry. */
export class LeaseLostError extends Error {
  constructor() {
    super("lease-lost");
    this.name = "LeaseLostError";
  }
}

export interface CompletePayload {
  sourceDigest: string;
  hasThumb: boolean;
  bytes: number;
  title: string;
  channel: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  publishedAt: string | null;
}

export class Api {
  constructor(private readonly config: Config) {}

  private async call(path: string, method: string, body: unknown): Promise<unknown> {
    const res = await fetch(new URL(path, this.config.apiBaseUrl), {
      method,
      headers: {
        Authorization: `Bearer ${this.config.agentToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 409) {
      const text = await res.text();
      if (text.includes("lease-lost")) throw new LeaseLostError();
      throw new Error(`${method} ${path} → 409 ${text}`);
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Poll for work. Also the heartbeat that makes the UI's "offline" line accurate. */
  async claim(): Promise<AgentClaimJob | null> {
    const raw = await this.call("/api/agent/claim", "POST", {
      agentId: this.config.agentId,
      hostname: this.config.hostname,
    });
    return agentClaimResponse.parse(raw).job;
  }

  async progress(
    jobId: string,
    status: Extract<JobStatus, "downloading" | "normalizing" | "uploading">,
    stagePercent: number | null,
    detail: string | null,
  ): Promise<void> {
    await this.call(`/api/agent/jobs/${jobId}/progress`, "PATCH", {
      agentId: this.config.agentId,
      status,
      stagePercent,
      detail,
    });
  }

  async complete(jobId: string, payload: CompletePayload): Promise<void> {
    await this.call(`/api/agent/jobs/${jobId}/complete`, "POST", {
      agentId: this.config.agentId,
      ...payload,
    });
  }

  /**
   * Pull an uploaded original down from the Worker.
   *
   * Straight to disk rather than into memory: this is the same file the parent picked on their
   * phone, and the whole point of the rest of the pipeline is that videos are too big to hold.
   */
  async fetchOriginal(
    jobId: string,
    dest: string,
    onProgress: (percent: number | null, detail: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const url = new URL(
      `/api/agent/jobs/${jobId}/original?agentId=${encodeURIComponent(this.config.agentId)}`,
      this.config.apiBaseUrl,
    );
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.agentToken}` },
      signal,
    });

    if (res.status === 409) throw new LeaseLostError();
    if (!res.ok || !res.body) {
      throw new Error(`取原片失败 → ${res.status} ${await res.text().catch(() => "")}`);
    }

    const total = Number(res.headers.get("Content-Length") ?? "");
    let received = 0;
    const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      const mb = (received / 1024 / 1024).toFixed(0);
      onProgress(
        Number.isFinite(total) && total > 0 ? (received / total) * 100 : null,
        `已取 ${mb} MB`,
      );
    });

    await pipeline(body, createWriteStream(dest), { signal });
  }

  async fail(jobId: string, error: string, retryable: boolean): Promise<void> {
    await this.call(`/api/agent/jobs/${jobId}/fail`, "POST", {
      agentId: this.config.agentId,
      error,
      retryable,
    });
  }
}
