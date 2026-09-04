import { useCallback, useEffect, useRef, useState } from "react";
import { isTerminal, type LibraryResponse } from "@kel/shared";
import { libraryWithEtag, UnauthenticatedError } from "./api.js";

const IDLE_POLL_MS = 30_000;
/** While a job is moving, the parent is watching the bar — poll fast enough to feel live. */
const ACTIVE_POLL_MS = 3_000;

export interface LibraryState {
  data: LibraryResponse | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useLibrary(onUnauthenticated: () => void): LibraryState {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const etag = useRef<string | null>(null);
  const inFlight = useRef(false);
  const unauth = useRef(onUnauthenticated);
  unauth.current = onUnauthenticated;

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await libraryWithEtag(etag.current);
      etag.current = result.etag;
      // A 304 leaves `data` alone: no re-render, no re-filter, no scroll jump.
      if (result.data) setData(result.data);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        unauth.current();
        return;
      }
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasActiveJob = data?.jobs.some((j) => !isTerminal(j.status)) ?? false;

  useEffect(() => {
    const interval = setInterval(
      () => {
        // Polling a backgrounded tab is pure waste; iOS suspends timers there anyway.
        if (document.visibilityState === "visible") void load();
      },
      hasActiveJob ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    );

    // Coming back to the app is the moment the data is most likely stale.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasActiveJob, load]);

  return { data, error, loading, refresh: () => void load() };
}
