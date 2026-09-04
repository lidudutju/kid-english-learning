# Transcripts come from YouTube, and Focus Words are counted rather than inferred

A Transcript is whatever caption track yt-dlp can pull in the same pass that fetches the video —
YouTube's own if the channel wrote one, its auto-generated one otherwise, and nothing at all for a
file uploaded from the phone. The Focus Words are then counted from that text by a pure function in
`packages/shared`, in the Agent, before the Video is ever registered. Two decisions, both of which
had a more impressive-sounding alternative.

**No speech recognition for uploads.** Whisper on the Mac was the obvious move: the Agent is
already a machine at home with ffmpeg on it, and every other gap in this app gets filled there. It
was rejected on material, not on effort. What gets uploaded from the phone is singing, a room with
a toddler in it, and a parent's voice over the top — the worst case for ASR, and the case where a
wrong answer does real damage. A Transcript is only ever *read*; Focus Words are **acted on**. They
decide which new Video shows up in Today's Watchlist, so a hallucinated line does not merely look
odd in the panel, it quietly aims tonight's viewing at words the Video never said. An uploaded
Video with no Transcript is honestly empty and the UI says so; an uploaded Video with a guessed one
is wrong in a way nobody would ever check. The interface stays open — `DownloadedTranscript` is
produced by the source step, and the upload branch returns `null` rather than being unable to
return anything — so adding ASR later is one function, not a refactor.

**Focus Words are counted, not asked of a model.** For this material repetition *is* the teaching.
A nursery rhyme says its target word twenty times and everything else once; "Baby Shark" is about
`shark`, `baby`, `doo`, and no summariser is going to beat counting that. Counting is also free,
offline, deterministic, and — the part that matters most — checkable. `pnpm check:focus` pins the
exact output for a dozen real caption shapes, which is not a thing that can be done to a prompt.
Phrases are ranked by **length** rather than by count, which is the one non-obvious rule: counting
every n-gram means a repetitive fragment always outscores the line containing it, so "doo doo" (×6)
would beat "baby shark doo doo doo" (×2), and the app would answer "what does this teach" with
something true and useless.

**The Agent counts them, the Worker stores the answer.** This is a CPU-budget decision, the same
one that shapes ADR-0003. `focusFrom` over a full-size 1500-cue Transcript measures ~6 ms on the
Mac; a Worker request has 10 ms of CPU for everything. So the numbers ride in the
`POST /api/agent/jobs/:id/complete` body and are written verbatim, in the same `DB.batch()` that
inserts the Video — one transaction, so the polled manifest never shows a Video whose Focus Words
are still in flight.

## Consequences

- A Video uploaded from the phone has no Transcript panel and no Focus Words, so it can never be
  chosen as a mostly-known new Video for the Watchlist. It still plays, still counts views, still
  gets a Review schedule. This is the cost of the decision and it is visible in the UI rather than
  hidden.
- `packages/shared/src/vtt.ts` has to survive real auto-captions: rolling cues that restate the
  line already on screen, per-word `<00:00:01.234>` timings, `<c>` spans, `[Music]`, and three
  different timestamp formats. The nastiest case is telling a caption being *redrawn* apart from a
  chorus sung *twice* — identical text, back to back, either way. Duration decides it: a rolling
  line ends with a flush cue a few milliseconds long, and nobody sings a line in 40 ms. The tie
  breaks toward "real repeat", because repetition is the entire signal.
- The size caps (1500 cues, 300 chars per cue) are enforced by the parser, not only by the Zod
  schema, so anything the Agent can produce is by construction something the Worker will accept.
  Otherwise a twenty-minute encode could be rejected at the finish line over a caption file.
- Because the Agent computes and the Worker trusts, an Agent left un-updated on some other machine
  could write Focus Words from an older algorithm. Nothing would break and nothing would warn.
  `pnpm check:focus` is what makes that visible: it is the same pinned definition both sides claim
  to implement, and it must be run after touching either file.
- Transcript text is denormalised into `transcripts.text` and searched with `LIKE`, not FTS5. One
  library, a few hundred Videos, a query typed by one person on a phone — an FTS5 virtual table is
  a second thing to migrate and keep in sync for a latency nobody can perceive.
- The Transcript itself stays out of the polled library manifest (it is the bulk of the data and is
  wanted for exactly one Video at a time, behind its own 24 h-cached ETag route), but the small
  Focus Words list rides along in it. That is what makes searching a lyric word work in the browser
  with no request at all; the server-side `LIKE` search only fills in what the local index missed.
- The nightly export carries `lang`, `kind` and the Focus Words but deliberately **not** the cues
  or the text. Those are the bulk, and they are fully re-derivable by re-ingesting — unlike a hand
  set Learning Stage, which is not.
