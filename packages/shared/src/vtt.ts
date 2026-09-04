/**
 * WebVTT → cues.
 *
 * Lives in `shared` rather than in the Agent because a parser that quietly drops half a
 * Transcript is exactly the kind of bug nothing else would catch: the Video still plays, the
 * panel still shows text, and the Focus Words are just wrong. `pnpm check:focus` pins it against
 * real YouTube output, both hand-written and auto-generated.
 */

export interface TranscriptCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/**
 * Ceilings on what one Transcript may be.
 *
 * Enforced by the parser rather than only by the schema, so that anything `parseVtt` produces is
 * by construction something the Worker will accept: the alternative is the Agent finishing a
 * twenty-minute encode and then having the registration rejected over a caption file. A cue
 * longer than this is not a caption, and a rhyme with more cues than this is a compilation whose
 * tail nobody will read.
 */
export const MAX_CUE_CHARS = 300;
export const MAX_TRANSCRIPT_CUES = 1500;

/** `00:01:02.500` and `01:02.500` both appear in the wild; so does a comma for the decimal. */
function parseTimestamp(raw: string): number | null {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(raw.trim());
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return (
    Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms!.padEnd(3, "0")) / 1000
  );
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * One cue's payload, as text a person would read.
 *
 * Auto-captions arrive full of `<c>` spans, per-word `<00:00:01.234>` timings and `[Music]`
 * annotations. None of that is language the Learner hears, and all of it would be counted as
 * words by the Focus Words pass.
 */
function cleanText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    // Bracketed stage directions, plus the note glyphs that mark singing.
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[♪♫]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Duration below which a cue is a caption being flushed rather than a line anyone sang.
 *
 * The distinction that matters most in this file, and it cannot be made from the gap between
 * cues: a chorus sung twice in a row and a caption redrawn are both back-to-back cues with
 * identical text. What tells them apart is length. YouTube's auto-captions end a rolling line by
 * re-emitting it as a cue a few milliseconds long; nobody sings a line in 40 ms.
 *
 * Erring toward "this is a real repeat" is deliberate. Repetition is the entire signal Focus
 * Words are counted from, so a merge that should not have happened costs more than a duplicate
 * line in the panel.
 */
const REDRAW_MAX_SECONDS = 0.4;

export function parseVtt(source: string): TranscriptCue[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const cues: TranscriptCue[] = [];

  /**
   * The previous cue's text *before* de-rolling, which is what the next one repeats.
   *
   * YouTube's auto-captions roll: each cue re-states the line already on screen and appends the
   * new one. Left alone, every line would be counted twice and the panel would read like a
   * stutter — so the carried-over prefix is stripped, and a cue that turns out to add nothing is
   * dropped entirely.
   */
  let carried = "";

  for (let i = 0; i < lines.length; i++) {
    const arrow = lines[i]!.indexOf("-->");
    if (arrow < 0) continue;

    const startSeconds = parseTimestamp(lines[i]!.slice(0, arrow));
    // Cue settings (`align:start position:0%`) follow the end timestamp on the same line.
    const endSeconds = parseTimestamp(lines[i]!.slice(arrow + 3).trim().split(/\s+/)[0] ?? "");
    if (startSeconds === null || endSeconds === null) continue;

    const payload: string[] = [];
    while (++i < lines.length && lines[i]!.trim() !== "") {
      // A cue block never contains a second timestamp line; if it does, the file is malformed
      // and the outer loop should get another look at this line.
      if (lines[i]!.includes("-->")) {
        i--;
        break;
      }
      payload.push(lines[i]!);
    }

    const full = cleanText(payload.join(" "));
    if (!full) continue;

    /*
     * De-roll, but only when this cue genuinely *extends* the last one.
     *
     * The `full.length > carried.length` guard is what separates a roll from a repeat. A rolling
     * caption restates the line on screen and appends to it, so the new cue is strictly longer;
     * a chorus sung again restates it and stops there. Stripping the prefix in that second case
     * would leave nothing and the line would be dropped — which is precisely how a song's most
     * repeated line ends up counted once.
     */
    let text = full;
    if (carried && full.length > carried.length && full.startsWith(carried)) {
      text = full.slice(carried.length).trim();
    }
    carried = full;
    if (!text) continue;

    const last = cues[cues.length - 1];
    const overlaps = last !== undefined && startSeconds < last.endSeconds;
    const flush = endSeconds - startSeconds <= REDRAW_MAX_SECONDS;
    if (last && last.text === text && (overlaps || flush)) {
      last.endSeconds = Math.max(last.endSeconds, endSeconds);
      continue;
    }

    cues.push({ startSeconds, endSeconds, text: text.slice(0, MAX_CUE_CHARS) });
    if (cues.length >= MAX_TRANSCRIPT_CUES) break;
  }

  return cues;
}

/** The Transcript as one string: what search matches against, and what reads back sanely. */
export function transcriptText(cues: TranscriptCue[]): string {
  return cues.map((c) => c.text).join("\n");
}
