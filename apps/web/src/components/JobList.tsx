import { isTerminal, JOB_STATUS_LABEL, overallPercent, type IngestJob } from "@kel/shared";
import { api } from "../api.js";

interface Props {
  jobs: IngestJob[];
  agentOnline: boolean;
  onChanged: () => void;
}

export function JobList({ jobs, agentOnline, onChanged }: Props) {
  if (jobs.length === 0) return null;

  return (
    <ul className="space-y-2">
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} agentOnline={agentOnline} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function JobRow({ job, agentOnline, onChanged }: { job: IngestJob; agentOnline: boolean; onChanged: () => void }) {
  const percent = overallPercent(job.status, job.stagePercent);
  const failed = job.status === "failed";

  /**
   * A failed upload has nothing left to retry: the original is deleted the moment the job dies,
   * so the only honest recovery is picking the file again. Offering 重试 here would fail every
   * time and look like the app being broken rather than the file being gone.
   */
  const retryable = failed && job.sourceKind !== "upload";

  /**
   * The honest version of "queued". Ingest runs on a machine at home (docs/adr/0001), so a
   * queued job with no Agent online is not slow — it is not happening, and a spinner would be
   * a lie.
   */
  /**
   * Queued, but deliberately not yet eligible: the last attempt failed and the Worker is holding
   * it back for a minute or two. Without saying so this reads as "家里的机器没开机", which is the
   * wrong thing to go and check.
   */
  const backingOff =
    job.status === "queued" && job.nextAttemptAt !== null && job.nextAttemptAt > Date.now();

  const waitingOnOfflineAgent = job.status === "queued" && !backingOff && !agentOnline;

  const idle = backingOff || waitingOnOfflineAgent;

  return (
    <li className="rounded-xl border border-hairline-soft bg-canvas p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">
            {job.title ?? job.sourceUrl ?? job.sourceKey}
          </p>
          <p className="mt-0.5 text-xs text-faint">
            {backingOff ? (
              <span className="text-yellow-dark">
                第 {job.attempts} 次没成功 · 稍后自动重试
                {job.error ? ` · ${job.error}` : ""}
              </span>
            ) : waitingOnOfflineAgent ? (
              <span className="text-yellow-dark">已排队 · 家里的机器没开机</span>
            ) : failed ? (
              <span className="text-coral-dark">
                {job.error ?? "失败"}
                {!retryable && " · 重新选一次文件吧"}
              </span>
            ) : (
              <>
                {JOB_STATUS_LABEL[job.status]}
                {job.detail ? ` · ${job.detail}` : ""}
                {job.attempts > 1 ? ` · 第 ${job.attempts} 次` : ""}
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!isTerminal(job.status) && !idle && (
            <span className="text-xs tabular-nums text-faint">{percent}%</span>
          )}
          {retryable && (
            <button
              onClick={() => void api.retryJob(job.id).then(onChanged)}
              className="min-h-tap rounded-full border border-hairline-strong bg-canvas px-4 text-xs font-medium text-ink active:bg-surface"
            >
              重试
            </button>
          )}
          {isTerminal(job.status) && (
            <button
              onClick={() => void api.dismissJob(job.id).then(onChanged)}
              className="min-h-tap px-2 text-xs text-stone"
              aria-label="移除这条记录"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {!isTerminal(job.status) && !idle && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-hairline-soft">
          <div
            className="h-full bg-brand-blue transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </li>
  );
}
