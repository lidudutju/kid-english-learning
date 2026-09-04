import { Hono } from "hono";
import { loginRequest } from "@kel/shared";
import type { AppBindings, Env } from "../env.js";
import { clearedCookie, createSession, sessionCookie, verifyPassword } from "../auth.js";

export const authRoutes = new Hono<AppBindings>();

/**
 * Rate limiting matters more here than the KDF does — see docs/adr/0003. Unbound in local
 * dev, which is why this tolerates a missing binding rather than failing closed.
 */
async function loginAllowed(env: Env, ip: string | undefined): Promise<boolean> {
  if (!env.LOGIN_LIMIT) return true;
  const { success } = await env.LOGIN_LIMIT.limit({ key: ip ?? "unknown" });
  return success;
}

authRoutes.post("/login", async (c) => {
  if (!(await loginAllowed(c.env, c.req.header("CF-Connecting-IP")))) {
    return c.json({ error: "尝试太频繁，请稍后再试" }, 429);
  }

  const parsed = loginRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "请求格式不对" }, 400);

  if (!(await verifyPassword(c.env.APP_PASSWORD_HASH, parsed.data.password))) {
    return c.json({ error: "密码不对" }, 401);
  }

  const { token, payload } = await createSession(c.env.SESSION_SECRET, "full");
  const secure = new URL(c.req.url).protocol === "https:";
  c.header("Set-Cookie", sessionCookie(token, secure));
  return c.json({ scope: payload.scope, expiresAt: payload.exp * 1000 });
});

authRoutes.post("/logout", (c) => {
  const secure = new URL(c.req.url).protocol === "https:";
  c.header("Set-Cookie", clearedCookie(secure));
  return c.json({ ok: true });
});

authRoutes.get("/me", (c) => {
  const session = c.get("session");
  return c.json({ scope: session.scope, expiresAt: session.exp * 1000 });
});
