import { spawn } from "node:child_process";

export interface RunOptions {
  /** Called for each complete line on stdout. */
  onStdout?: (line: string) => void;
  /** Called for each complete line on stderr. */
  onStderr?: (line: string) => void;
  signal?: AbortSignal;
}

export class ProcessError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly tail: string,
  ) {
    super(`${command} exited with ${code}\n${tail}`);
    this.name = "ProcessError";
  }
}

/**
 * Run a subprocess, streaming both pipes line by line.
 *
 * Line-buffered rather than chunk-based because every caller here is parsing progress
 * output, and a chunk boundary in the middle of a progress line silently corrupts it.
 */
export function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    const pump = (
      stream: NodeJS.ReadableStream,
      onLine: ((line: string) => void) | undefined,
      collect: (chunk: string) => void,
    ) => {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        collect(chunk);
        if (!onLine) return;
        buffer += chunk;
        // \r matters: ffmpeg and yt-dlp both redraw progress with carriage returns.
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) onLine(line);
      });
      stream.on("end", () => {
        if (onLine && buffer.trim()) onLine(buffer);
      });
    };

    pump(child.stdout, options.onStdout, (c) => {
      stdout += c;
    });
    pump(child.stderr, options.onStderr, (c) => {
      stderr += c;
    });

    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(
        new Error(
          `启动 ${command} 失败：${err.message}。` +
            `（是不是没装？试试 brew install yt-dlp ffmpeg）`,
        ),
      );
    });

    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (code === 0) return resolve({ stdout, stderr });
      const tail = (stderr || stdout).split("\n").slice(-12).join("\n");
      reject(new ProcessError(command, code, tail));
    });
  });
}
