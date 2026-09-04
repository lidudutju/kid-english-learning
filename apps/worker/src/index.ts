import { Hono } from "hono";
import type { AppBindings, Env } from "./env.js";
import { SESSION_COOKIE, verifyAgentToken, verifySession } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { libraryRoutes } from "./routes/library.js";
import { jobRoutes, videoRoutes } from "./routes/videos.js";
import { learningRoutes } from "./routes/learning.js";
import { uploadRoutes } from "./routes/uploads.js";
import { agentRoutes } from "./routes/agent.js";
import { nightly } from "./cron.js";

const app = new Hono<AppBindings>();

/** Paths under /api that must work without a session cookie. */
const PUBLIC_API = new Set(["/api/auth/login", "/api/auth/logout"]);

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The Agent authenticates with a bearer token, never with the session cookie. */
app.use("/api/agent/*", async (c, next) => {
  if (!verifyAgentToken(c.env.AGENT_TOKEN, c.req.header("Authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_API.has(path) || path.startsWith("/api/agent/")) return next();

  const session = await verifySession(
    c.env.SESSION_SECRET,
    readCookie(c.req.header("Cookie"), SESSION_COOKIE),
  );
  if (!session) return c.json({ error: "unauthenticated" }, 401);

  c.set("session", session);
  return next();
});

app.route("/api/auth", authRoutes);
app.route("/api/library", libraryRoutes);
app.route("/api/videos", videoRoutes);
// Stage, Affinity and Watches hang off a Video, so they share its prefix.
app.route("/api/videos", learningRoutes);
app.route("/api/uploads", uploadRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/agent", agentRoutes);

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  console.error("unhandled", err);
  return c.json({ error: "服务出错了" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(nightly(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
