-- Transcripts and the Focus Words counted from them (docs/adr/0005).
--
-- One row per Video, not per cue: the cues are only ever read all at once, by the Player showing
-- one Video, and a table with a row per line would be tens of thousands of rows to serve exactly
-- the same JSON. The columns that are *not* the cues are the ones worth having separately —
-- `text` is what search scans, and `focus_words` is what the manifest carries.
CREATE TABLE transcripts (
  video_id TEXT PRIMARY KEY REFERENCES videos (id),

  -- 'en', 'en-US', 'en-GB' — whatever the Source actually offered. Kept as-is rather than
  -- normalised, because when a Transcript reads oddly this is half the explanation.
  lang TEXT NOT NULL,
  -- 'manual' | 'auto'. The other half of that explanation.
  kind TEXT NOT NULL,

  -- The cues, as the JSON array the API serves. Stored rather than assembled per request: it
  -- never changes, and the Worker has a 10ms CPU budget to spend on better things.
  cues TEXT NOT NULL,
  -- Every cue's text, one per line. Denormalised on purpose — searching means a LIKE over this
  -- column, and doing it over `cues` would mean parsing every Transcript in the library to find
  -- out which ones matched.
  text TEXT NOT NULL,

  -- { words: [{text, count}], phrases: [...] }, counted once by shared/focus.ts in the Agent —
  -- a full-length Transcript costs ~6ms and a Worker request has 10ms of CPU in total. Stored
  -- rather than re-derived, so improving the algorithm does not shift the numbers under a Video
  -- the family already knows; scripts/check-focus.ts is what pins the two sides to one definition.
  focus_words TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
