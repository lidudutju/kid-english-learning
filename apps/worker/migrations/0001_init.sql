-- Phase 1 schema: the library, the ingest queue, and the Agent registry.

CREATE TABLE videos (
  id               TEXT PRIMARY KEY,
  source_kind      TEXT NOT NULL,
  source_key       TEXT NOT NULL,
  source_url       TEXT,
  source_digest    TEXT NOT NULL,
  asset_prefix     TEXT NOT NULL,
  playable_key     TEXT NOT NULL,
  thumb_key        TEXT,
  title            TEXT NOT NULL,
  channel          TEXT,
  duration_seconds REAL,
  width            INTEGER,
  height           INTEGER,
  bytes            INTEGER,
  published_at     TEXT,
  added_at         INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- The two hard Duplicate blocks. Both are enforced here, not only in application code,
-- so a race between two submissions cannot produce a second copy.
CREATE UNIQUE INDEX videos_source_key ON videos (source_key);
CREATE UNIQUE INDEX videos_source_digest ON videos (source_digest);
CREATE INDEX videos_added_at ON videos (added_at DESC);

CREATE TABLE ingest_jobs (
  id               TEXT PRIMARY KEY,
  source_kind      TEXT NOT NULL,
  source_key       TEXT NOT NULL,
  source_url       TEXT,
  asset_prefix     TEXT NOT NULL,
  title            TEXT,
  status           TEXT NOT NULL,
  stage_percent    REAL,
  detail           TEXT,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  agent_id         TEXT,
  lease_expires_at INTEGER,
  video_id         TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- One live job per Source. Finished and failed jobs are excluded so the same link can be
-- retried, or re-added after a Removal, without tripping over history.
CREATE UNIQUE INDEX ingest_jobs_live_source
  ON ingest_jobs (source_key)
  WHERE status NOT IN ('done', 'failed');

CREATE INDEX ingest_jobs_claimable ON ingest_jobs (status, created_at);
CREATE INDEX ingest_jobs_created_at ON ingest_jobs (created_at DESC);

-- Progress belongs to a Learner from day one, even though Phase 1 does not read it.
CREATE TABLE learners (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO learners (id, name, created_at)
VALUES ('default', 'Learner', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- Which machines at home have checked in. Lets the UI say "the machine at home is
-- offline" instead of showing a job that will never move.
CREATE TABLE agents (
  id           TEXT PRIMARY KEY,
  hostname     TEXT,
  last_seen_at INTEGER NOT NULL
);
