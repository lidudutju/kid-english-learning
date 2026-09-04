import { Link } from "react-router-dom";
import { STAGE_LABEL, type Progress, type Video } from "@kel/shared";
import { formatDay, formatDuration, formatRelative } from "../format.js";
import { isPending } from "../progress.js";

interface Props {
  video: Video;
  progress: Progress;
  today: string;
  /** Where the player's back arrow should return to. */
  from?: "today";
}

/**
 * One row, used by both the library and Today.
 *
 * The second line is learning information as soon as there is any, and falls back to
 * channel/added otherwise — an untouched library should look exactly like it did before any of
 * this existed, and a used one should answer "他看过这个吗" without a tap.
 */
export function VideoRow({ video, progress, today, from }: Props) {
  // Due *and* not done today — the dot has to go away when the job is done.
  const due = isPending(progress, today);
  const touched = progress.stage !== "new" || progress.watchCount > 0;

  return (
    <li>
      <Link
        to={`/v/${video.id}`}
        state={from}
        className="flex items-center gap-3 rounded-xl p-2 active:bg-surface"
      >
        <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-lg border border-hairline-soft bg-surface">
          {video.thumbUrl && (
            <img
              src={video.thumbUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          )}
          <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] tabular-nums text-white">
            {formatDuration(video.durationSeconds)}
          </span>
          {due && (
            <span
              className="absolute left-1 top-1 h-2.5 w-2.5 rounded-full bg-brand-yellow-deep ring-2 ring-white"
              aria-label="该复习了"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-snug text-ink">{video.title}</p>
          <p className="mt-1 truncate text-xs text-stone">
            {touched ? (
              <>
                <span className={due ? "font-semibold text-yellow-dark" : ""}>
                  {STAGE_LABEL[progress.stage]}
                </span>
                {progress.watchCount > 0 && ` · 看过 ${progress.watchCount} 次`}
                {progress.affinity === "loves" && " · 很喜欢"}
                {progress.affinity === "refuses" && " · 不肯看"}
                {progress.nextReviewOn !== null &&
                  progress.stage !== "done" &&
                  progress.affinity !== "refuses" &&
                  ` · ${formatDay(progress.nextReviewOn, today)}`}
              </>
            ) : (
              [video.channel, formatRelative(video.addedAt)].filter(Boolean).join(" · ")
            )}
          </p>
        </div>
      </Link>
    </li>
  );
}
