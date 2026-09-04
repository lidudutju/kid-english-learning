# Kid English Learning

A private family video library for teaching English to a young child (3+). A parent collects
songs, dance clips and lessons — from YouTube links or their own files — and tracks how far the
child has got with each one.

## Language

### Content

**Video**:
One piece of watchable material in the library, with its own learning progress and metadata.
_Avoid_: item, asset, entry, media

**Source**:
Where a Video came from — a YouTube link or a file the parent uploaded.
_Avoid_: origin, provider

**Source Key**:
The stable identity of a Source, normalised so the same thing paste twice looks the same.
For YouTube that is `youtube:<videoId>`, extracted from any link shape (`youtu.be/X`,
`watch?v=X&t=45s`, `music.youtube.com`, embeds).
_Avoid_: url, link, external id

**Source Digest**:
The SHA-256 of the bytes as they arrived from the Source, before any normalisation. Two
Videos may never share a Source Digest.
_Avoid_: checksum, file hash, content hash

**Duplicate**:
A Video whose Source Key or Source Digest already exists in the library. Duplicates are
refused outright. Two different recordings of the same song are *not* duplicates — the
library holds both, and no warning is shown.

**Removal**:
Erasing a Video completely: its Playable, its Transcript, its Progress, its history, and its
place in the Duplicate check. There is no archive and no undo. Because the identity goes too,
the same Source may afterwards be added again as a new Video.
_Avoid_: delete (the act), archive, trash, soft delete

**Playable**:
The single normalised MP4 (H.264 + AAC, `moov` at the front) stored in R2 and served to the
browser. Every Video has exactly one. It is derived, not the original — re-deriving it
produces different bytes, which is why identity lives on the Source Digest.
_Avoid_: rendition, transcode, output, stream

### Ingestion

**Ingest**:
The whole act of getting a Source into the library: fetch or receive, extract metadata,
compute the Source Digest, normalise to a Playable, store, register.

**Ingest Job**:
One queued attempt to Ingest one Source, with a lifecycle the parent can watch and retry.

**Agent**:
The program running on a machine at home that does the heavy part of Ingest — yt-dlp and
ffmpeg — because neither can run on Cloudflare's edge. It pulls Ingest Jobs and uploads
Playables straight to R2.
_Avoid_: worker (means a Cloudflare Worker), daemon, downloader

**Transcript**:
The timed text of a Video — pulled from YouTube's own or auto-generated captions, or produced
locally by speech recognition for uploaded files. Searchable, and the source the Focus Words
are drawn from.
_Avoid_: subtitles, captions, srt

**Focus Words**:
The handful of words and sentence patterns a Video actually teaches, extracted from its
Transcript. What Review is built on, and what makes it possible to say whether a new Video is
mostly-known or mostly-new.
_Avoid_: vocabulary, keywords, tags

### Learning

**Learner**:
The child whose progress is tracked. Distinct from the person operating the app — there is one
of each today, but Progress always belongs to a Learner, never to the library.
_Avoid_: user, kid, student

**Progress**:
What one Learner has done with one Video: its Stage, its Affinity, and the counters derived
from Watches. There is exactly one per (Learner, Video).
_Avoid_: status, state, record

**Stage**:
How far the Learner has got with a Video, judged by the parent because a machine cannot see a
toddler mouthing along:
`New` → `Introduced` (seen once or twice, still strange) → `Familiar` (reacts, points, moves
to it) → `Joining In` (sings or gestures along) → `Mastered` (produces it away from the
screen) → `Done` (no longer needs Review).
Receptive stages (`Familiar`) and productive stages (`Joining In`) are deliberately separate:
a 3-year-old who understands but stays silent is in a normal silent period, not behind.
_Avoid_: level, status, mastery

**Affinity**:
How the Learner feels about a Video — `Loves` / `Neutral` / `Refuses` — tracked separately
from Stage because slow progress is often a taste problem, not an ability problem. A
`Refuses` Video is excluded from Review and recommendations.
_Avoid_: rating, like, preference, score

**Watch**:
One recorded viewing that got far enough to count — 30 seconds, or 40% of the Video, whichever
comes first. Playing the same Video again from the start is a new Watch, because a toddler
asking for it a third time is the signal the app exists to capture. Watches are never entered
by hand; repetition count and last-watched are derived from them.
_Avoid_: view, play, session, history

**Preview**:
Watching a Video as the parent — checking it downloaded correctly, or deciding whether it is
any good. A Preview produces no Watch and touches no Progress. Without this distinction,
checking twenty new uploads would look like the Learner having studied twenty times.
_Avoid_: test, check, admin view

**Review**:
Re-watching a Video that is due, on a fixed widening ladder — same day, +1, +2, +4, +7, +15,
+30 — rather than an adult spaced-repetition algorithm. Toddlers need short, frequent cycles.
_Avoid_: repetition, spaced repetition, SRS, revision

**Due**:
A Video whose next Review date has arrived, for a given Learner.

**Today's Watchlist**:
The short list the app puts in front of the parent each day: what is Due, plus one or two new
Videos chosen for overlapping mostly-known Focus Words. Deliberately short — attention at this
age runs 10–15 minutes.
_Avoid_: queue, feed, recommendations, playlist
