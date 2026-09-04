/** Workers Rate Limiting binding. Optional so `wrangler dev` works without it bound. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  PRIVATE: R2Bucket;
  ASSETS: Fetcher;
  LOGIN_LIMIT?: RateLimiter;

  /** Public origin the Playables are served from, e.g. `https://media.felixli.io`. */
  MEDIA_BASE_URL: string;

  /** `pbkdf2$sha256$<iterations>$<saltHex>$<hashHex>` — see scripts/hash-password.mjs. */
  APP_PASSWORD_HASH: string;
  /** HMAC key for session cookies. Rotating it logs everyone out, which is the point. */
  SESSION_SECRET: string;
  /** Bearer token the Agent authenticates with. */
  AGENT_TOKEN: string;
}

export type Scope = "full" | "kid";

export interface SessionPayload {
  sub: string;
  scope: Scope;
  iat: number;
  exp: number;
}

export type AppBindings = {
  Bindings: Env;
  Variables: { session: SessionPayload };
};
