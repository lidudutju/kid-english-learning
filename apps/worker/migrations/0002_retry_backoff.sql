-- Retries need to wait. Without this column the three attempts burn in under ten seconds:
-- the Agent fails, the Worker re-queues, the Agent's next poll picks it straight back up.
-- Anything transient — a flaky home connection, YouTube rate-limiting the machine for a
-- minute — therefore ends as a permanent failure. NULL means "eligible now", so every
-- existing row keeps its current behaviour.
ALTER TABLE ingest_jobs ADD COLUMN next_attempt_at INTEGER;
