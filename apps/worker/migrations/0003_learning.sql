-- Progress, Watches and the Review ladder. One row per (Learner, Video), created lazily:
-- a Video nobody has touched is `new` and neutral, and storing a few hundred rows saying so
-- would only make the library response bigger.

CREATE TABLE progress (
  learner_id      TEXT NOT NULL,
  video_id        TEXT NOT NULL,
  -- Judged by the parent, not derived: a machine cannot see a toddler mouthing along.
  stage           TEXT NOT NULL DEFAULT 'new',
  -- Tracked apart from stage on purpose — slow progress is often a taste problem.
  affinity        TEXT NOT NULL DEFAULT 'neutral',
  -- Derived from watches, never entered by hand.
  watch_count     INTEGER NOT NULL DEFAULT 0,
  last_watched_at INTEGER,
  review_step     INTEGER NOT NULL DEFAULT 0,
  -- 'YYYY-MM-DD' in Asia/Shanghai. A day, not an instant: Review is a calendar ladder, and
  -- a timestamp would make "due today" depend on which timezone read it.
  next_review_on  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (learner_id, video_id)
);

CREATE INDEX progress_due ON progress (learner_id, next_review_on);

-- Every viewing that got far enough to count: 30 seconds, or 40% of the Video. Kept as rows
-- rather than only a counter so a miscount can be inspected, and because "asked for it three
-- times today" is the signal this app exists to capture.
CREATE TABLE watches (
  id               TEXT PRIMARY KEY,
  learner_id       TEXT NOT NULL,
  video_id         TEXT NOT NULL,
  counted_at       INTEGER NOT NULL,
  seconds_watched  REAL NOT NULL,
  -- The day it counted, so a day's session can be counted without re-deriving the timezone.
  counted_on       TEXT NOT NULL
);

CREATE INDEX watches_video ON watches (video_id, counted_at DESC);
CREATE INDEX watches_day ON watches (learner_id, counted_on);
