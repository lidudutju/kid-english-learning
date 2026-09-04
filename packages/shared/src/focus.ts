/**
 * Focus Words: the handful of words and sentence patterns a Video actually teaches.
 *
 * Counted from repetition rather than asked of a model, because for this material repetition
 * *is* the teaching. A nursery rhyme says its target word twenty times and everything else once
 * — "Baby Shark" is about `shark`, `baby`, `doo`, and no summariser is going to beat counting.
 * A pure function in `shared` also means the Worker that stores them, the browser that shows
 * them, and `pnpm check:focus` all agree on one definition.
 */

import type { Stage } from "./learning.js";
import type { TranscriptCue } from "./vtt.js";

/**
 * English function words, which every Transcript is made of and none of which is the point.
 *
 * Kept deliberately short: only words that are frequent *regardless* of subject. Question words
 * (`what`, `where`, `how`) are missing on purpose — "where is my nose" is exactly the kind of
 * pattern this app wants to surface, and a Video that repeats `where` twenty times is teaching
 * it.
 */
export const STOPWORDS = new Set([
  "a", "about", "all", "am", "an", "and", "any", "are", "as", "at", "away",
  "be", "been", "but", "by",
  "can", "cause", "come", "coming",
  "did", "do", "does", "doing", "done", "dont",
  "each", "every",
  "for", "from",
  "get", "getting", "go", "going", "gonna", "got",
  "had", "has", "have", "he", "her", "here", "hers", "him", "his",
  "i", "if", "im", "in", "into", "is", "it", "its",
  "just",
  "let", "lets", "like",
  "me", "mine", "more", "my",
  "no", "not", "now",
  "of", "off", "oh", "ok", "okay", "on", "one", "or", "our", "out",
  "said", "say", "says", "she", "so", "some",
  "than", "that", "thats", "the", "their", "them", "then", "there", "these",
  "they", "this", "those", "to", "too",
  "up", "us",
  "very",
  "was", "we", "well", "were", "will", "with", "would",
  "yeah", "yes", "you", "your", "youre",
]);

/** A word said once is something the Video mentions; twice or more is something it teaches. */
export const FOCUS_MIN_COUNT = 2;
/** Enough to see what a Video is about at a glance, few enough to read in one line. */
export const FOCUS_MAX_WORDS = 8;
export const FOCUS_MAX_PHRASES = 3;
/**
 * Sentence patterns worth naming run from two words to a whole short line.
 *
 * Six is about the length of a line in a nursery rhyme — "head shoulders knees and toes" is five,
 * "how I wonder what you are" is six. Going higher costs a pass over every cue for a length that
 * would mostly catch two lines that happen to share a cue.
 */
const PHRASE_MIN_TOKENS = 2;
const PHRASE_MAX_TOKENS = 6;

export interface FocusWord {
  text: string;
  /** How many times the Transcript repeats it — the reason it is here. */
  count: number;
}

export interface Focus {
  /** Content words, most-repeated first. */
  words: FocusWord[];
  /** Repeated lines: the sentence patterns. */
  phrases: FocusWord[];
}

export const EMPTY_FOCUS: Focus = { words: [], phrases: [] };

/**
 * Words as the counter sees them.
 *
 * Apostrophes are dropped rather than split on, so `don't` becomes `dont` and lands on the
 * stopword list once instead of contributing a phantom `t`. Everything non-alphabetic is a
 * boundary: numerals in captions are almost always timestamps or artefacts.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’`]/g, "")
    .split(/[^a-z]+/)
    .filter((token) => token.length >= 2);
}

function ranked(counts: Map<string, number>, limit: number): FocusWord[] {
  return [...counts.entries()]
    .filter(([, count]) => count >= FOCUS_MIN_COUNT)
    // Alphabetical within a count so the same Transcript always yields the same list — the
    // Focus Words are shown next to a Video for months, and reshuffling on every re-derive
    // would make them look unreliable.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"))
    .slice(0, limit)
    .map(([text, count]) => ({ text, count }));
}

/**
 * Extract Focus Words.
 *
 * Cue by cue, never across the boundary: two lines that happen to meet do not make a phrase.
 */
export function focusFrom(cues: TranscriptCue[]): Focus {
  const words = new Map<string, number>();
  const phrases = new Map<string, number>();

  for (const cue of cues) {
    const tokens = tokenize(cue.text);

    for (const token of tokens) {
      if (STOPWORDS.has(token)) continue;
      words.set(token, (words.get(token) ?? 0) + 1);
    }

    for (let n = PHRASE_MIN_TOKENS; n <= PHRASE_MAX_TOKENS; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n);
        // A two-word run of pure function words ("in the") is not a pattern. Longer runs are:
        // "how are you" is all stopwords and is precisely what a parent wants to see listed.
        if (n === PHRASE_MIN_TOKENS && gram.every((t) => STOPWORDS.has(t))) continue;
        const key = gram.join(" ");
        phrases.set(key, (phrases.get(key) ?? 0) + 1);
      }
    }
  }

  return {
    words: ranked(words, FOCUS_MAX_WORDS),
    phrases: pickPhrases(phrases),
  };
}

/**
 * The longest repeated line, then the next one that is not part of it.
 *
 * Longest first, *not* most-repeated first, and that ordering is the whole design. Counting every
 * n-gram means a repetitive fragment always outscores the line containing it — "Baby Shark" has
 * "doo doo" six times and "baby shark doo doo doo" twice, because the shorter window fits inside
 * the longer one several times over. Ranking by count would therefore answer "what does this
 * video teach" with "doo doo", which is true and useless.
 *
 * So: the longest thing repeated at all wins, and anything overlapping it is dropped — in either
 * direction, since both "shark doo doo" and "doo doo" are just parts of a line already listed.
 * The count survives into the UI, so a pattern repeated twice does not get to look like a chorus
 * sung twenty times.
 */
function pickPhrases(counts: Map<string, number>): FocusWord[] {
  const candidates = [...counts.entries()]
    .filter(([, count]) => count >= FOCUS_MIN_COUNT)
    .map(([text, count]) => ({ text, count, tokens: text.split(" ").length }))
    .sort(
      (a, b) =>
        b.tokens - a.tokens || b.count - a.count || a.text.localeCompare(b.text, "en"),
    );

  const kept: FocusWord[] = [];
  for (const { text, count } of candidates) {
    // Word-boundary containment: `" doo "` inside `" baby shark doo doo doo "`, so that "he"
    // is not treated as part of "head".
    const padded = ` ${text} `;
    const overlaps = kept.some((k) => {
      const other = ` ${k.text} `;
      return other.includes(padded) || padded.includes(other);
    });
    if (overlaps) continue;
    kept.push({ text, count });
    if (kept.length >= FOCUS_MAX_PHRASES) break;
  }
  return kept;
}

/* ------------------------------------------------------------------ what he already knows */

/**
 * Stages at which a Video's Focus Words count as known.
 *
 * `introduced` is not on the list: having seen something once or twice is not knowing the words
 * in it, and treating it as known would make every new Video look familiar after one evening.
 */
export const KNOWN_STAGES: readonly Stage[] = ["familiar", "joining_in", "mastered", "done"];

export function stageKnowsWords(stage: Stage): boolean {
  return KNOWN_STAGES.includes(stage);
}

/**
 * How much of a Video is words the Learner already has, 0–1.
 *
 * This is what "mostly-known" in CONTEXT.md means, and it is what Today's Watchlist picks new
 * Videos by: a song built from words he already has is one he can join in with tonight, whereas
 * one with nothing familiar in it is a cold start. A Video with no Focus Words scores 0 — it
 * carries no evidence either way, and should not outrank one that does.
 */
export function knownRatio(words: string[], known: ReadonlySet<string>): number {
  if (words.length === 0) return 0;
  const hits = words.filter((w) => known.has(w)).length;
  return hits / words.length;
}
