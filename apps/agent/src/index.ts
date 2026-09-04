import { mkdir } from "node:fs/promises";
import { Api } from "./api.js";
import { loadConfig } from "./config.js";
import { processJob } from "./pipeline.js";
import { makeClient } from "./r2.js";

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.workDir, { recursive: true });

  const api = new Api(config);
  const s3 = makeClient(config);

  log(`agent 启动：${config.agentId} → ${config.apiBaseUrl}`);
  log(`工作目录 ${config.workDir}，最高 ${config.maxHeight}p`);

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(1); // Second Ctrl-C means "now".
      stopping = true;
      log("收到停止信号，做完当前任务就退出（再按一次立即退出）");
    });
  }

  // Consecutive poll failures back off, so an Agent left running while the Worker is down
  // does not hammer it once a second forever.
  let consecutiveErrors = 0;

  while (!stopping) {
    try {
      const job = await api.claim();
      consecutiveErrors = 0;

      if (!job) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      log(`领到任务 ${job.id}（${job.sourceKey}，第 ${job.attempts} 次尝试）`);
      const outcome = await processJob(config, api, s3, job, log);

      if (outcome.status === "done") log(`任务 ${job.id} 完成`);
      else if (outcome.status === "failed") log(`任务 ${job.id} 失败：${outcome.message}`);
      else log(`任务 ${job.id} 放弃（租约丢失）`);

      // Straight back round: there may be more queued, and the parent is waiting.
    } catch (err) {
      consecutiveErrors++;
      const wait = Math.min(config.pollIntervalMs * 2 ** (consecutiveErrors - 1), 5 * 60_000);
      log(
        `轮询出错（第 ${consecutiveErrors} 次，${Math.round(wait / 1000)}s 后重试）：` +
          (err instanceof Error ? err.message : String(err)),
      );
      await sleep(wait);
    }
  }

  log("已退出");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
