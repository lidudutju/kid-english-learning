/**
 * Proof that WebVTT parsing and Focus Words behave the way the app promises.
 *
 * These two functions decide what the app claims a Video teaches, and both fail quietly. A parser
 * that drops half a Transcript still shows text in the panel; an extractor that counts a rolling
 * caption twice still produces plausible-looking words. Neither would ever throw, and the only
 * person who would notice is a parent wondering why "doo" is the word of the day.
 *
 * The stakes are higher than a normal parser test because of where the work happens: the Agent
 * counts the Focus Words and the Worker stores the answer without recomputing it (a full-size
 * Transcript costs ~6ms and a Worker has 10ms of CPU for the whole request). This script is the
 * thing that keeps the two honest. Run it after touching vtt.ts or focus.ts:
 *
 *   pnpm check:focus
 */
import { focusFrom, tokenize, STOPWORDS } from "../packages/shared/src/focus.js";
import {
  MAX_CUE_CHARS,
  MAX_TRANSCRIPT_CUES,
  parseVtt,
  transcriptText,
} from "../packages/shared/src/vtt.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.error(`✗ ${label}\n  got      ${a}\n  expected ${e}`);
}

/* ------------------------------------------------------------------ timestamps */

{
  // Hours present, hours absent, and a comma for the decimal separator: all three turn up in
  // real files, and a rejected timestamp means a silently dropped cue.
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.500
one

01:02.250 --> 01:04.000
two

00:01:05,000 --> 00:01:06,500
three
`;
  const cues = parseVtt(vtt);
  check("three timestamp formats all parse", cues.length, 3);
  check("h:mm:ss.mmm", [cues[0]!.startSeconds, cues[0]!.endSeconds], [1, 3.5]);
  check("mm:ss.mmm", [cues[1]!.startSeconds, cues[1]!.endSeconds], [62.25, 64]);
  check("comma decimal", [cues[2]!.startSeconds, cues[2]!.endSeconds], [65, 66.5]);
}

{
  // Cue settings follow the end timestamp on the same line and must not break it.
  const cues = parseVtt(
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start position:0%\nhello\n",
  );
  check("cue settings are ignored", cues, [
    { startSeconds: 1, endSeconds: 2, text: "hello" },
  ]);
}

/* ------------------------------------------------------ headers, ids, and noise */

{
  const vtt = `WEBVTT
Kind: captions
Language: en

NOTE this is a comment
that spans two lines

1
00:00:01.000 --> 00:00:02.000
first

STYLE
::cue { color: white }

2
00:00:03.000 --> 00:00:04.000
second
`;
  const cues = parseVtt(vtt);
  // The header block, the NOTE, the STYLE block and the numeric cue ids are all not captions.
  check("only real cues survive", cues.map((c) => c.text), ["first", "second"]);
}

{
  // A multi-line cue is one caption, and the newline inside it is not a line break in the text.
  const cues = parseVtt(
    "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHead, shoulders,\nknees and toes\n",
  );
  check("a two-line cue joins", cues[0]!.text, "Head, shoulders, knees and toes");
}

/* ------------------------------------------------------------- auto-caption markup */

{
  // What YouTube's auto-captions actually look like: per-word timings, <c> spans, and the
  // rolling repetition where each cue restates the line already on screen.
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:00.030 --> 00:00:02.000 align:start position:0%
twinkle twinkle

00:00:02.000 --> 00:00:04.000 align:start position:0%
twinkle twinkle <00:00:02.500><c>little</c> <00:00:03.000><c>star</c>

00:00:04.000 --> 00:00:06.000 align:start position:0%
how I wonder what you are
`;
  const cues = parseVtt(vtt);
  check("markup is stripped and the roll is de-duplicated", cues.map((c) => c.text), [
    "twinkle twinkle",
    "little star",
    "how I wonder what you are",
  ]);
  // The whole point of de-rolling: "twinkle" repeats twice in this Transcript, not four times.
  check("de-rolled counts", focusFrom(cues).words[0], { text: "twinkle", count: 2 });
}

{
  // The hardest distinction in the parser. A caption being flushed and a line sung twice in a
  // row look identical apart from duration: YouTube's auto-captions end a rolling line by
  // re-emitting it for a few milliseconds, and nobody sings a line that fast.
  const flushed = parseVtt(
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nbaby shark\n\n00:00:02.000 --> 00:00:02.010\nbaby shark\n",
  );
  check("a millisecond flush is one cue", flushed.length, 1);
  check("a flush extends the first", flushed[0]!.endSeconds, 2.01);

  // Overlapping cues are the other form of the same thing: the caption is literally still up.
  const overlapping = parseVtt(
    "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nbaby shark\n\n00:00:03.000 --> 00:00:06.000\nbaby shark\n",
  );
  check("an overlapping duplicate is one cue", overlapping.length, 1);

  // Back-to-back, both a real length: sung twice. This is the case that must NOT be merged —
  // it is a chorus, and merging it would count the library's most repeated line once.
  const twice = parseVtt(
    "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nbaby shark\n\n00:00:03.000 --> 00:00:06.000\nbaby shark\n",
  );
  check("a chorus sung twice is two cues", twice.length, 2);
  check("a chorus counts twice", focusFrom(twice).words, [
    { text: "baby", count: 2 },
    { text: "shark", count: 2 },
  ]);

  const laterVerse = parseVtt(
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nbaby shark\n\n00:00:30.000 --> 00:00:31.000\nbaby shark\n",
  );
  check("a repeat a verse later is two cues", laterVerse.length, 2);
}

{
  // Annotations and entities. `[Music]` is not language the Learner hears, and an unescaped
  // `&amp;` in the panel looks like a bug.
  const cues = parseVtt(
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n[Music] ♪ me &amp; you ♪\n\n00:00:03.000 --> 00:00:04.000\n[Applause]\n",
  );
  check("annotations go, entities decode", cues.map((c) => c.text), ["me & you"]);
}

/* -------------------------------------------------------------------- the caps */

{
  const many = ["WEBVTT", ""];
  for (let i = 0; i < MAX_TRANSCRIPT_CUES + 50; i++) {
    // Distinct text and a wide gap, so nothing is merged as a redraw or dropped as a roll.
    many.push(`00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000 --> 00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.500`);
    many.push(`line ${i}`);
    many.push("");
  }
  // Enforced by the parser, not only by the schema: the Agent must not be able to finish an
  // encode and then have the registration rejected over a caption file.
  check("cue count is capped", parseVtt(many.join("\n")).length, MAX_TRANSCRIPT_CUES);
}

{
  const long = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${"word ".repeat(200)}\n`;
  check("cue text is capped", parseVtt(long)[0]!.text.length, MAX_CUE_CHARS);
}

/* ------------------------------------------------------------- malformed input */

check("empty input", parseVtt(""), []);
check("header only", parseVtt("WEBVTT\n\n"), []);
check("a cue with no text is dropped", parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n"), []);
check(
  "a bad timestamp skips its cue, not the file",
  parseVtt(
    "WEBVTT\n\n00:00:0x.000 --> 00:00:02.000\nbroken\n\n00:00:03.000 --> 00:00:04.000\nfine\n",
  ).map((c) => c.text),
  ["fine"],
);
{
  // Two timestamp lines with no blank line between them: malformed, and the second cue must
  // still be seen rather than swallowed as the first one's text.
  const cues = parseVtt(
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\none\n00:00:03.000 --> 00:00:04.000\ntwo\n",
  );
  check("a missing blank line loses nothing", cues.map((c) => c.text), ["one", "two"]);
}
check(
  "CRLF line endings",
  parseVtt("WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nhello\r\n").map((c) => c.text),
  ["hello"],
);

/* ----------------------------------------------------------------- tokenising */

check("apostrophes fold rather than split", tokenize("don't stop"), ["dont", "stop"]);
check("a curly apostrophe folds too", tokenize("don’t"), ["dont"]);
check("punctuation is a boundary", tokenize("one, two. three!"), ["one", "two", "three"]);
check("digits are not words", tokenize("1 2 buckle my shoe"), ["buckle", "my", "shoe"]);
// Single letters are dropped, which is what keeps a stray "I" or the "s" of a possessive out.
check("single letters are dropped", tokenize("a b cd"), ["cd"]);
check("case is folded", tokenize("Twinkle TWINKLE"), ["twinkle", "twinkle"]);
// `dont` has to be on the list *after* folding, or the most common contraction in English
// becomes a Focus Word.
check("dont is a stopword", STOPWORDS.has("dont"), true);

/* --------------------------------------------------------------- focus words */

{
  // A real rhyme's shape: one word said over and over, everything else once or twice.
  const cues = [
    { startSeconds: 0, endSeconds: 2, text: "baby shark doo doo doo" },
    { startSeconds: 10, endSeconds: 12, text: "baby shark doo doo doo" },
    { startSeconds: 20, endSeconds: 22, text: "mommy shark doo doo doo" },
    { startSeconds: 30, endSeconds: 32, text: "let us go hunt" },
  ];
  const focus = focusFrom(cues);
  check("the repeated words, most first", focus.words.map((w) => w.text), [
    "doo",
    "shark",
    "baby",
  ]);
  check("doo is counted every time", focus.words[0]!.count, 9);
  // "hunt" is said once. A word a Video mentions is not a word it teaches.
  check("a word said once is not a Focus Word", focus.words.some((w) => w.text === "hunt"), false);

  /*
   * The whole reason phrases are ranked by length rather than by count. "doo doo" occurs six
   * times here and "baby shark doo doo doo" twice, because the short window fits inside the long
   * line more than once — so counting would answer "什么歌" with "doo doo".
   */
  check("the longest repeated line wins", focus.phrases[0], {
    text: "baby shark doo doo doo",
    count: 2,
  });
  // …and nothing that is merely a piece of it is listed alongside it.
  check("fragments of it are not listed", focus.phrases.length, 1);
}

{
  // Determinism. The Focus Words sit next to a Video for months, so a tie must not reshuffle
  // between two runs — alphabetical order within a count is what guarantees that.
  const cues = [
    { startSeconds: 0, endSeconds: 1, text: "zebra apple" },
    { startSeconds: 10, endSeconds: 11, text: "apple zebra" },
  ];
  check("ties are alphabetical", focusFrom(cues).words.map((w) => w.text), ["apple", "zebra"]);
}

{
  // Phrases never span a cue boundary: two lines that happen to meet are not a pattern.
  const cues = [
    { startSeconds: 0, endSeconds: 1, text: "wash your hands" },
    { startSeconds: 2, endSeconds: 3, text: "before you eat" },
    { startSeconds: 10, endSeconds: 11, text: "wash your hands" },
    { startSeconds: 12, endSeconds: 13, text: "before you eat" },
  ];
  const phrases = focusFrom(cues).phrases.map((p) => p.text);
  check("no phrase crosses a cue", phrases.includes("hands before"), false);
  check("within-cue phrases are found", phrases.includes("wash your hands"), true);
}

{
  // An all-stopword pair is not a pattern, but an all-stopword *question* is exactly the kind
  // of thing worth surfacing.
  const pair = [
    { startSeconds: 0, endSeconds: 1, text: "in the box" },
    { startSeconds: 10, endSeconds: 11, text: "in the bag" },
  ];
  check("'in the' is not a phrase", focusFrom(pair).phrases.some((p) => p.text === "in the"), false);

  const question = [
    { startSeconds: 0, endSeconds: 1, text: "how are you today" },
    { startSeconds: 10, endSeconds: 11, text: "how are you today" },
  ];
  check(
    "a stopword question is a phrase",
    focusFrom(question).phrases[0]!.text,
    "how are you today",
  );
}

check("an empty Transcript has no Focus Words", focusFrom([]), { words: [], phrases: [] });

/* ------------------------------------------------------------------- one string */

check(
  "transcriptText is one cue per line",
  transcriptText([
    { startSeconds: 0, endSeconds: 1, text: "one" },
    { startSeconds: 2, endSeconds: 3, text: "two" },
  ]),
  "one\ntwo",
);

/* --------------------------------------------------------------- end to end */

{
  // The path a real Video takes: yt-dlp writes this, the Agent parses and counts it, the Worker
  // stores both. If this one breaks, the Focus Words in the app are wrong.
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:03.000
Head, shoulders, knees and toes

00:00:03.000 --> 00:00:06.000
Head, shoulders, knees and toes

00:00:06.000 --> 00:00:09.000
Eyes and ears and mouth and nose

00:00:09.000 --> 00:00:12.000
Head, shoulders, knees and toes
`;
  const cues = parseVtt(vtt);
  check("four cues survive the round trip", cues.length, 4);
  const focus = focusFrom(cues);
  check("body parts are the Focus Words", focus.words.map((w) => w.text), [
    "head",
    "knees",
    "shoulders",
    "toes",
  ]);
  check("the chorus is the phrase", focus.phrases[0], {
    text: "head shoulders knees and toes",
    count: 3,
  });
}

if (failures > 0) {
  console.error(`\n${failures} 处不符`);
  process.exit(1);
}
console.log("focus: 字幕解析和重点词统计都符合预期");
