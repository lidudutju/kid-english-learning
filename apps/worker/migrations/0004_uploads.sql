-- Manual uploads. The bytes arrive from the browser in parts, land in the private bucket, and
-- are fetched from there by the Agent, which then runs exactly the same second half of the
-- pipeline as a YouTube link (docs/adr/0001, docs/adr/0004).

-- Known before the upload starts, because the browser hashes the file first. For YouTube jobs
-- this stays NULL and the digest only exists once the Agent has the bytes.
ALTER TABLE ingest_jobs ADD COLUMN source_digest TEXT;

-- Where the original waits in the private bucket, and the multipart upload it is arriving
-- through. Both are cleared once the Video is registered — the Playable is what we keep.
ALTER TABLE ingest_jobs ADD COLUMN original_key TEXT;
ALTER TABLE ingest_jobs ADD COLUMN upload_id TEXT;
ALTER TABLE ingest_jobs ADD COLUMN source_bytes INTEGER;

-- A 'receiving' job is one whose bytes are still coming from the browser. It is excluded from
-- the library manifest, so this index is what makes finding the abandoned ones cheap.
CREATE INDEX ingest_jobs_receiving ON ingest_jobs (status, updated_at);
