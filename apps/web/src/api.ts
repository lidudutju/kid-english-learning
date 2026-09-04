import {
  libraryResponse,
  type Affinity,
  type LibraryResponse,
  type Progress,
  type Stage,
} from "@kel/shared";

/** Thrown when the session cookie is missing or expired — the UI shows the login screen. */
export class UnauthenticatedError extends Error {
  constructor() {
    super("unauthenticated");
    this.name = "UnauthenticatedError";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 401) throw new UnauthenticatedError();
  return res;
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await request(path, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `请求失败（${res.status}）`, res.status);
  return body as T;
}

export const api = {
  async login(password: string): Promise<void> {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(body.error ?? "登录失败", res.status);
  },

  logout: () => json<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  me: () => json<{ scope: string; expiresAt: number }>("/api/auth/me"),

  addYoutube: (url: string) =>
    json<{ jobId: string; sourceKey: string }>("/api/videos/youtube", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  removeVideo: (id: string) =>
    json<{ ok: true }>(`/api/videos/${id}`, { method: "DELETE" }),

  retryJob: (id: string) => json<{ ok: true }>(`/api/jobs/${id}/retry`, { method: "POST" }),

  dismissJob: (id: string) => json<{ ok: true }>(`/api/jobs/${id}`, { method: "DELETE" }),

  /** Stage and Affinity: the parent's judgement, sent one tap at a time. */
  setProgress: (id: string, patch: { stage?: Stage; affinity?: Affinity }) =>
    json<{ progress: Progress }>(`/api/videos/${id}/progress`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /**
   * A Watch. Never called during a Preview — that distinction is the whole reason checking
   * twenty new uploads does not look like the Learner having studied twenty times.
   */
  recordWatch: (id: string, secondsWatched: number) =>
    json<{ counted: boolean; progress: Progress }>(`/api/videos/${id}/watches`, {
      method: "POST",
      body: JSON.stringify({ secondsWatched }),
    }),

  prepareUpload: (body: {
    sourceDigest: string;
    filename: string;
    bytes: number;
    title?: string | null;
  }) =>
    json<{ jobId: string; partBytes: number; partCount: number }>("/api/uploads", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** One part of a file. Raw bytes, so this one cannot go through the JSON helper. */
  async uploadPart(jobId: string, partNumber: number, chunk: Blob): Promise<string> {
    const res = await fetch(`/api/uploads/${jobId}/parts/${partNumber}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunk,
    });
    if (res.status === 401) throw new UnauthenticatedError();
    const body = (await res.json().catch(() => ({}))) as { error?: string; etag?: string };
    if (!res.ok || !body.etag) {
      throw new ApiError(body.error ?? `第 ${partNumber} 块传不上去`, res.status);
    }
    return body.etag;
  },

  completeUpload: (jobId: string, parts: { partNumber: number; etag: string }[]) =>
    json<{ ok: true }>(`/api/uploads/${jobId}/complete`, {
      method: "POST",
      body: JSON.stringify({ parts }),
    }),

  abortUpload: (jobId: string) =>
    json<{ ok: true }>(`/api/uploads/${jobId}`, { method: "DELETE" }),
};

/**
 * Fetch the whole library, carrying the ETag through.
 *
 * A 304 means nothing changed and there is nothing to re-parse, which is what makes polling
 * every few seconds cheap enough to be the only sync mechanism this app needs.
 */
export async function libraryWithEtag(
  etag: string | null,
): Promise<{ data: LibraryResponse | null; etag: string | null }> {
  const res = await request("/api/library", {
    headers: etag ? { "If-None-Match": etag } : {},
  });
  if (res.status === 304) return { data: null, etag };
  if (!res.ok) throw new ApiError(`加载失败（${res.status}）`, res.status);
  return {
    data: libraryResponse.parse(await res.json()),
    etag: res.headers.get("ETag") ?? null,
  };
}
