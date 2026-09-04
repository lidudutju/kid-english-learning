import { Hono } from "hono";
import type { TranscriptResponse, TranscriptSearchResponse } from "@kel/shared";
import type { AppBindings } from "../env.js";
import { toTranscript, type TranscriptRow } from "../db.js";

export const transcriptRoutes = new Hono<AppBindings>();
export const transcriptSearchRoutes = new Hono<AppBindings>();

/**
 * One Video's Transcript.
 *
 * Deliberately not part of the library manifest, which is polled: a few hundred Transcripts is
 * megabytes, and the Player only ever needs the one it is showing. This response never changes
 * once written, so it is the one thing in the app worth caching hard.
 */
transcriptRoutes.get("/:id/transcript", async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM transcripts WHERE video_id = ?1`)
    .bind(c.req.param("id"))
    .first<TranscriptRow>();

  if (!row) return c.json({ error: "这个视频没有字幕" }, 404);

  const body: TranscriptResponse = toTranscript(row);
  const etag = `W/"t-${row.updated_at}"`;
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  c.header("ETag", etag);
  // A Transcript is written once and never edited, so the phone may keep it for the day. It is
  // still `private`: this is behind the session cookie.
  c.header("Cache-Control", "private, max-age=86400");
  return c.json(body);
});

/** Fewer than the phone can show at once, and few enough to keep the query cheap. */
const MAX_HITS = 10;
/** Characters of context around a match. Enough to recognise the line, not enough to scroll. */
const SNIPPET_RADIUS = 60;

/**
 * Search inside Transcripts.
 *
 * The only server-side search in the app, and the exception proves the rule: title and channel
 * search happens in the browser because the whole manifest is already there (routes/library.ts),
 * whereas Transcripts are the one thing too big to ship up front. So this route exists purely
 * because "which video has 'twinkle' in it" cannot be answered from what the client holds.
 *
 * A LIKE scan, not FTS5. D1 supports FTS5, but an index would have to be kept in step with the
 * table, and for a library of a few hundred short rhymes a scan over one denormalised text
 * column is milliseconds — the cost of the extra machinery would be paid in bugs, not seconds.
 */
transcriptSearchRoutes.get("/search", async (c) => {
  const query = (c.req.query("q") ?? "").trim();
  if (query.length < 2) {
    const empty: TranscriptSearchResponse = { query, hits: [], truncated: false };
    return c.json(empty);
  }

  // `%` and `_` are wildcards in LIKE, and `\` is the escape character named below. Without this
  // a search for `_` matches every Transcript in the library.
  const pattern = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

  const { results } = await c.env.DB.prepare(
    `SELECT t.video_id, t.text
       FROM transcripts t
       JOIN videos v ON v.id = t.video_id
      WHERE t.text LIKE ?1 ESCAPE '\\'
      ORDER BY v.added_at DESC
      LIMIT ?2`,
  )
    .bind(pattern, MAX_HITS + 1)
    .all<{ video_id: string; text: string }>();

  const truncated = results.length > MAX_HITS;
  const body: TranscriptSearchResponse = {
    query,
    hits: results.slice(0, MAX_HITS).map((row) => ({
      videoId: row.video_id,
      snippet: snippetOf(row.text, query),
      // Always null today. `text` is one cue per line and carries no timings, and parsing every
      // hit's cue JSON to recover them would cost more CPU than the whole search. The field is
      // here because the snippet is the *only* thing that knows which line matched, so if the
      // Player is ever to open at that line, this is where the number has to come from — nothing
      // reads it yet, and tapping a hit opens the Video at the start.
      startSeconds: null,
    })),
    truncated,
  };

  return c.json(body);
});

/**
 * The matching line, trimmed to something that fits under a title.
 *
 * Case-insensitive, because the stored text is as-captioned and nobody types "Twinkle".
 */
function snippetOf(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, SNIPPET_RADIUS * 2).replace(/\n/g, " ");

  // Widen to the ends of the line the match is on, then clip.
  const lineStart = text.lastIndexOf("\n", at) + 1;
  const lineEndRaw = text.indexOf("\n", at);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;

  const from = Math.max(lineStart, at - SNIPPET_RADIUS);
  const to = Math.min(lineEnd, at + query.length + SNIPPET_RADIUS);
  const core = text.slice(from, to);
  return `${from > lineStart ? "…" : ""}${core}${to < lineEnd ? "…" : ""}`;
}
