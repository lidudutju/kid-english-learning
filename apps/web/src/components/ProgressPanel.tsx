import { useState } from "react";
import {
  AFFINITIES,
  AFFINITY_LABEL,
  needsReview,
  STAGES,
  STAGE_HINT,
  STAGE_LABEL,
  type Affinity,
  type Progress,
  type Stage,
} from "@kel/shared";
import { api } from "../api.js";
import { formatDay, formatRelative } from "../format.js";

interface Props {
  videoId: string;
  progress: Progress;
  today: string;
  /** Seconds of this playthrough, for the live "还差一点" line. */
  secondsWatched: number;
  counted: boolean;
  watchThreshold: number;
  preview: boolean;
  onProgress: (progress: Progress) => void;
}

/**
 * Stage, Affinity and where Review stands.
 *
 * Stage and Affinity are the parent's judgement and only ever change by being tapped — nothing
 * here is inferred from playback except the one transition the machine actually knows about
 * (没看过 → 看过了, applied server-side when a Watch is recorded). Tapping a Stage deliberately
 * does *not* touch the Review ladder: saying "他会用了" is not the same as having revised it
 * today, and conflating the two would corrupt the schedule.
 */
export function ProgressPanel({
  videoId,
  progress,
  today,
  secondsWatched,
  counted,
  watchThreshold,
  preview,
  onProgress,
}: Props) {
  const [saving, setSaving] = useState<"stage" | "affinity" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(key: "stage" | "affinity", change: { stage?: Stage; affinity?: Affinity }) {
    setSaving(key);
    setError(null);
    try {
      const res = await api.setProgress(videoId, change);
      onProgress(res.progress);
    } catch (err) {
      setError(err instanceof Error ? err.message : "没保存上");
    } finally {
      setSaving(null);
    }
  }

  const reviewing = needsReview(progress.stage, progress.affinity);

  return (
    <section className="mt-6 space-y-5">
      <div>
        <h2 className="mb-2 text-xs font-medium text-slate-400">学到哪了</h2>
        <div className="flex flex-wrap gap-2">
          {STAGES.map((s) => (
            <button
              key={s}
              onClick={() => void save("stage", { stage: s })}
              disabled={saving !== null}
              aria-pressed={progress.stage === s}
              title={STAGE_HINT[s]}
              className={`min-h-tap rounded-full px-3.5 text-sm disabled:opacity-60 ${
                progress.stage === s
                  ? "bg-sky-600 font-medium text-white"
                  : "bg-slate-800 text-slate-300"
              }`}
            >
              {STAGE_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">{STAGE_HINT[progress.stage]}</p>
      </div>

      <div>
        <h2 className="mb-2 text-xs font-medium text-slate-400">他喜欢吗</h2>
        <div className="flex flex-wrap gap-2">
          {AFFINITIES.map((a) => (
            <button
              key={a}
              onClick={() => void save("affinity", { affinity: a })}
              disabled={saving !== null}
              aria-pressed={progress.affinity === a}
              className={`min-h-tap rounded-full px-3.5 text-sm disabled:opacity-60 ${
                progress.affinity === a
                  ? a === "refuses"
                    ? "bg-rose-700 font-medium text-white"
                    : "bg-emerald-700 font-medium text-white"
                  : "bg-slate-800 text-slate-300"
              }`}
            >
              {AFFINITY_LABEL[a]}
            </button>
          ))}
        </div>
        {progress.affinity === "refuses" && (
          <p className="mt-2 text-xs text-slate-500">不肯看的不会再排进今天要看的。</p>
        )}
      </div>

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <dl className="grid grid-cols-2 gap-y-2 border-t border-slate-800 pt-4 text-xs">
        <dt className="text-slate-500">看过</dt>
        <dd className="text-right tabular-nums">
          {progress.watchCount} 次
          {progress.lastWatchedAt ? ` · ${formatRelative(progress.lastWatchedAt)}` : ""}
        </dd>
        <dt className="text-slate-500">下次复习</dt>
        <dd className="text-right">
          {reviewing ? formatDay(progress.nextReviewOn, today) : "不用复习"}
        </dd>
      </dl>

      {/*
        The one bit of feedback that stops "为什么次数没加" from being a mystery: a Watch needs
        30 秒 or 40% of the Video, and skipping around does not count toward it.
      */}
      {!preview && (
        <p className="text-xs text-slate-500">
          {counted
            ? "这次算一遍了。"
            : secondsWatched > 0
              ? `看满 ${Math.ceil(watchThreshold)} 秒才算一遍（已看 ${Math.floor(secondsWatched)} 秒）。`
              : `看满 ${Math.ceil(watchThreshold)} 秒才算一遍。`}
        </p>
      )}
    </section>
  );
}
