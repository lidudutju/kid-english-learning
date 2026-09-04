/**
 * Pre-flight checks, run with `pnpm -F @kel/agent doctor [youtube-url]`.
 *
 * These are exactly the things that were unknown when this was designed: whether yt-dlp works
 * against the channels we care about, whether YouTube still offers `avc1 + mp4a` for them, and
 * whether the R2 credentials and the Agent token are right. Finding out here beats finding out
 * from a job that fails three times at 2am.
 */
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { loadConfig, type Config } from "./config.js";
import { makeClient } from "./r2.js";
import { run } from "./proc.js";

let failures = 0;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const testUrl = process.argv[2];

  let config: Config;
  try {
    config = loadConfig();
    console.log(`配置：${config.agentId} → ${config.apiBaseUrl}\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log("本地工具：");
  await check("yt-dlp", async () => {
    const { stdout } = await run(config.ytDlp, ["--version"]);
    return stdout.trim();
  });
  await check("ffmpeg", async () => {
    const { stdout } = await run(config.ffmpeg, ["-version"]);
    return stdout.split("\n")[0]?.slice(0, 60) ?? "";
  });
  await check("ffprobe", async () => {
    const { stdout } = await run(config.ffprobe, ["-version"]);
    return stdout.split("\n")[0]?.slice(0, 60) ?? "";
  });
  await check("libx264（源不是 H.264 时要用）", async () => {
    const { stdout } = await run(config.ffmpeg, ["-hide_banner", "-encoders"]);
    if (!stdout.includes("libx264")) throw new Error("这个 ffmpeg 没编进 libx264");
    return "可用";
  });

  console.log("\nCloudflare：");
  await check("Worker 可达且 token 正确", async () => {
    const res = await fetch(new URL("/api/agent/ping", config.apiBaseUrl), {
      headers: { Authorization: `Bearer ${config.agentToken}` },
    });
    if (res.status === 401) throw new Error("token 不对（KEL_AGENT_TOKEN 和 Worker secret 不一致）");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return "ok";
  });
  await check(`R2 桶 ${config.r2Bucket} 可写`, async () => {
    const client = makeClient(config);
    await client.send(new HeadBucketCommand({ Bucket: config.r2Bucket }));
    return "凭据有效";
  });

  if (testUrl) {
    console.log("\nYouTube（这条链接）：");
    await check("能选到 avc1 + mp4a", async () => {
      const { stdout } = await run(config.ytDlp, [
        "--simulate",
        "--no-playlist",
        "--no-warnings",
        "-f",
        `bv*[vcodec^=avc1][height<=?${config.maxHeight}]+ba[acodec^=mp4a]`,
        "--print",
        "%(height)sp %(vcodec)s %(acodec)s",
        testUrl,
      ]).catch(() => {
        throw new Error(
          "选不到 avc1+mp4a，会退回到 VP9/AV1 并触发重新编码（能用，但慢，而且电视可能不认）",
        );
      });
      return stdout.trim().split("\n").pop() ?? "";
    });
  } else {
    console.log("\n（想顺手验一条 YouTube 链接：pnpm -F @kel/agent doctor <url>）");
  }

  console.log(failures === 0 ? "\n全部通过。" : `\n${failures} 项没通过。`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
