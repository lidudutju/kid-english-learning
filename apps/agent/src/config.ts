import { hostname } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * Everything machine-specific lives here and nowhere else.
 *
 * This Agent is expected to move to a different Mac, so there are no absolute paths in the
 * source, the binaries are looked up on PATH by default, and the identity defaults to the
 * hostname — moving means copying one .env file.
 */
loadDotenv({ path: process.env.KEL_ENV_FILE ?? join(process.cwd(), ".env") });

const schema = z.object({
  apiBaseUrl: z.string().url(),
  agentToken: z.string().min(8),
  agentId: z.string().min(1).max(64),
  hostname: z.string(),
  workDir: z.string(),

  r2AccountId: z.string().min(1),
  r2AccessKeyId: z.string().min(1),
  r2SecretAccessKey: z.string().min(1),
  r2Bucket: z.string().min(1),

  /** Cap the download height. 1080p is already more than a phone or a TV needs here. */
  maxHeight: z.coerce.number().int().min(240).max(2160),
  pollIntervalMs: z.coerce.number().int().min(1000),
  heartbeatMs: z.coerce.number().int().min(500),

  ytDlp: z.string().min(1),
  ffmpeg: z.string().min(1),
  ffprobe: z.string().min(1),

  /** Optional: a cookies.txt to get past age gates and bot checks. */
  cookiesFile: z.string().nullable(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const env = process.env;
  const parsed = schema.safeParse({
    apiBaseUrl: env.KEL_API_BASE_URL,
    agentToken: env.KEL_AGENT_TOKEN,
    agentId: env.KEL_AGENT_ID || hostname().replace(/\.local$/, ""),
    hostname: hostname(),
    workDir: resolve(env.KEL_WORK_DIR || join(homedir(), ".kel-agent", "work")),

    r2AccountId: env.KEL_R2_ACCOUNT_ID,
    r2AccessKeyId: env.KEL_R2_ACCESS_KEY_ID,
    r2SecretAccessKey: env.KEL_R2_SECRET_ACCESS_KEY,
    r2Bucket: env.KEL_R2_BUCKET || "kel-media",

    maxHeight: env.KEL_MAX_HEIGHT || 1080,
    pollIntervalMs: env.KEL_POLL_INTERVAL_MS || 10_000,
    heartbeatMs: env.KEL_HEARTBEAT_MS || 2_000,

    ytDlp: env.KEL_YTDLP_PATH || "yt-dlp",
    ffmpeg: env.KEL_FFMPEG_PATH || "ffmpeg",
    ffprobe: env.KEL_FFPROBE_PATH || "ffprobe",

    cookiesFile: env.KEL_COOKIES_FILE || null,
  });

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Agent 配置不完整：\n${missing}\n\n` +
        `请照着 apps/agent/.env.example 建一个 apps/agent/.env。`,
    );
  }
  return parsed.data;
}
