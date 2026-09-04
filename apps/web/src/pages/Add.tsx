import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { isTerminal, parseYoutubeInput, titleFromFilename, YOUTUBE_PARSE_MESSAGE } from "@kel/shared";
import { api } from "../api.js";
import { BackLink } from "../components/BackLink.js";
import { JobList } from "../components/JobList.js";
import { formatBytes } from "../format.js";
import type { LibraryState } from "../useLibrary.js";
import { checkFile, uploadVideo, UPLOAD_PHASE_LABEL, type UploadState } from "../upload.js";

export function Add({ library }: { library: LibraryState }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Same parser the Worker uses, so a bad link is rejected before a round trip.
  const parsed = url.trim() ? parseYoutubeInput(url) : null;
  const clientError = parsed && !parsed.ok ? YOUTUBE_PARSE_MESSAGE[parsed.reason] : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!parsed?.ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.addYoutube(url.trim());
      setUrl("");
      library.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  const jobs = library.data?.jobs ?? [];
  const active = jobs.filter((j) => !isTerminal(j.status));
  const recent = jobs.filter((j) => isTerminal(j.status)).slice(0, 10);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-4">
      <header className="mb-4 flex items-center gap-3">
        <BackLink to="/" />
        <h1 className="text-lg font-medium tracking-tight text-ink">添加视频</h1>
      </header>

      <form onSubmit={submit} className="space-y-3">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="粘贴 YouTube 链接"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-h-tap w-full rounded-lg border border-hairline-strong bg-canvas px-4 py-3 text-ink outline-none focus:border-brand-blue"
        />
        {(clientError ?? error) && (
          <p className="text-sm text-coral-dark">{clientError ?? error}</p>
        )}
        <button
          type="submit"
          disabled={busy || !parsed?.ok}
          className="min-h-tap w-full rounded-full bg-ink px-4 py-3 text-sm font-medium text-white active:bg-charcoal disabled:bg-hairline disabled:text-mist"
        >
          {busy ? "提交中…" : "加入队列"}
        </button>
      </form>

      <p className="mt-3 text-xs leading-relaxed text-stone">
        下载和转码在家里的机器上跑，所以加入队列后可以直接关掉这个页面。
        {library.data && !library.data.agentOnline && (
          <span className="text-yellow-dark">（现在那台机器没在线，任务会先排队。）</span>
        )}
      </p>

      <UploadCard onQueued={library.refresh} />

      {active.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-faint">进行中</h2>
          <JobList
            jobs={active}
            agentOnline={library.data?.agentOnline ?? false}
            onChanged={library.refresh}
          />
        </section>
      )}

      {recent.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-faint">最近</h2>
          <JobList
            jobs={recent}
            agentOnline={library.data?.agentOnline ?? false}
            onChanged={library.refresh}
          />
        </section>
      )}
    </div>
  );
}

/**
 * Upload a file from the phone.
 *
 * The file is read twice — hashed, then sent — and the hash goes up first, so a file already in
 * the library is refused before a single byte of it is uploaded (docs/adr/0004). Everything
 * after the last part is the same pipeline a YouTube link goes through: the machine at home
 * normalises it and it appears in the library.
 */
function UploadCard({ onQueued }: { onQueued: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [state, setState] = useState<UploadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  // Closing the tab mid-upload leaves a half-arrived file the nightly sweep has to clean up, and
  // the parent has to start over — worth one warning.
  useEffect(() => {
    if (!state) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  function pick(picked: File | null) {
    setError(null);
    setQueued(false);
    if (!picked) {
      setFile(null);
      return;
    }
    const problem = checkFile(picked);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(picked);
    setTitle(titleFromFilename(picked.name));
  }

  async function start() {
    if (!file) return;
    setError(null);
    setState({ phase: "hashing", percent: 0 });
    try {
      await uploadVideo(file, title.trim() || null, setState);
      setFile(null);
      setTitle("");
      setQueued(true);
      if (input.current) input.current.value = "";
      onQueued();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setState(null);
    }
  }

  return (
    <section className="mt-8 border-t border-hairline pt-6">
      <h2 className="mb-2 text-sm font-medium text-faint">或者从手机里选一个</h2>

      <input
        ref={input}
        type="file"
        accept="video/*"
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
        disabled={state !== null}
        className="min-h-tap w-full text-sm text-faint file:mr-3 file:min-h-tap file:rounded-full file:border file:border-hairline-strong file:bg-canvas file:px-4 file:text-sm file:font-medium file:text-ink"
      />

      {file && !state && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-stone">
            {file.name} · {formatBytes(file.size)}
          </p>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="标题"
            className="min-h-tap w-full rounded-lg border border-hairline-strong bg-canvas px-4 py-3 text-ink outline-none focus:border-brand-blue"
          />
          <button
            onClick={() => void start()}
            className="min-h-tap w-full rounded-full bg-ink px-4 py-3 text-sm font-medium text-white active:bg-charcoal"
          >
            上传
          </button>
        </div>
      )}

      {state && (
        <div className="mt-3">
          <p className="text-xs text-faint">
            {UPLOAD_PHASE_LABEL[state.phase]} · {Math.floor(state.percent)}%
          </p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-hairline-soft">
            <div
              className="h-full bg-brand-blue transition-[width] duration-300"
              style={{ width: `${state.percent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-stone">上传完成前别关掉这个页面。</p>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-coral-dark">{error}</p>}

      {queued && (
        <p className="mt-3 text-sm font-medium text-success">
          传完了，剩下的交给家里的机器，可以关掉页面了。
        </p>
      )}
    </section>
  );
}
