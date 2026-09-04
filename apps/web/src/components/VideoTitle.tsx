import { useEffect, useState } from "react";
import type { Video } from "@kel/shared";
import { api } from "../api.js";

/**
 * The Video's title on the Player, and the one place it can be changed.
 *
 * Renaming lives here rather than down with 删除 because this is where the problem is visible: a
 * clip picked on a phone arrives called `dd2d35a7f664….MOV`, and the moment anyone notices is the
 * moment they are looking at it. The 改名 button is a separate tap target instead of the title
 * itself being tappable — the title is three lines long on a phone and sits right where a thumb
 * lands when scrolling.
 */
export function VideoTitle({
  video,
  /** Pull the new title into every other screen — it is part of the library manifest. */
  onRenamed,
}: {
  video: Video;
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(video.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The name just typed, until the manifest agrees.
   *
   * `onRenamed` only *starts* a refresh, so for a poll's worth of time `video.title` is still the
   * old one. Showing it again the instant the input closes looks exactly like the rename having
   * failed, which is the one impression worth spending a few lines to avoid.
   */
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (saved !== null && video.title === saved) setSaved(null);
  }, [video.title, saved]);

  async function save() {
    const title = draft.trim();
    if (!title || title === video.title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.renameVideo(video.id, title);
      setSaved(title);
      setEditing(false);
      onRenamed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "改不了名字");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="min-w-0 flex-1 text-base font-medium leading-snug text-ink">
          {saved ?? video.title}
        </h1>
        <button
          onClick={() => {
            setDraft(saved ?? video.title);
            setError(null);
            setEditing(true);
          }}
          className="min-h-tap shrink-0 text-xs text-faint"
        >
          改名
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        // Enter saves and Escape gives up, because the on-screen keyboard covers the buttons.
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setEditing(false);
        }}
        autoFocus
        // A title is a name, not a sentence — iOS capitalising it and autocorrecting a band's
        // name into a real word both make it worse.
        autoCapitalize="off"
        autoCorrect="off"
        className="min-h-tap w-full rounded-lg border border-hairline-strong bg-canvas px-3 py-2 text-base text-ink outline-none focus:border-brand-blue"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={saving || draft.trim() === ""}
          className="min-h-tap rounded-full bg-ink px-4 text-xs font-medium text-white active:bg-charcoal disabled:bg-hairline disabled:text-mist"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          onClick={() => setEditing(false)}
          className="min-h-tap rounded-full border border-hairline-strong bg-canvas px-4 text-xs font-medium text-ink"
        >
          取消
        </button>
        {error && <span className="text-xs text-coral-dark">{error}</span>}
      </div>
    </div>
  );
}
