# Uploads are hashed in the browser and relayed through the Worker

A file picked on the phone is hashed there first, then pushed to the Worker in 8 MiB parts,
which forwards each part into an R2 multipart upload in the **private** bucket. Only after the
last part does the job enter the same queue a YouTube link enters, and the Agent pulls the
original back down through an authenticated Worker route. Three separate decisions, each of
which had an easier alternative.

**The digest is computed before the bytes move** because a Duplicate has to be refusable before
the upload, not after it. Source Digest is what catches the same video arriving under a
different name (CONTEXT.md), and it is a hard block with no "add anyway" — discovering that
after ten minutes of uploading over home wifi would be the single most annoying thing this app
could do. The browser has no streaming digest (`crypto.subtle.digest` is one-shot and a phone
must not hold a 2 GB video in memory), so SHA-256 is hand-rolled in `packages/shared/sha256.ts`
and proven against Node's implementation by `pnpm check:sha256`. The file is therefore read
twice — once to hash, once to send — which costs seconds and saves minutes.

**The parts go through the Worker** rather than straight to R2 because presigned URLs would mean
putting S3 credentials in the Worker, and the Worker has bucket *bindings* instead — no
credentials at all, nothing to leak, nothing to rotate. 8 MiB parts sit far enough inside the
100 MB request limit to be safe and are large enough that a 500 MB file is 60-odd requests
rather than thousands. A part can be re-sent freely: the same part number simply overwrites.

**The original lands in the private bucket** and is streamed to the Agent through
`GET /api/agent/jobs/:id/original`, lease-checked, rather than being dropped into the public
media bucket where the Agent could fetch it directly. Un-normalised family footage has no
business being reachable from the web (ADR-0002 makes that bucket world-readable), and the
Agent's R2 credentials stay scoped to `kel-media` alone. Once the Playable exists the original
is deleted — it doubles the storage for a file nothing reads.

## Consequences

- A new job status, `receiving`, exists for the window between "file announced" and "last part
  arrived". It is excluded from the library manifest: only the tab doing the uploading knows
  anything useful about its progress, and a row that cannot show a bar is worse than no row.
- That window holds the Source Key, so an abandoned upload would block re-picking the same
  file. Aborting on failure handles the normal case; the nightly sweep handles the closed lid,
  aborting multiparts and dropping `receiving` rows older than six hours.
- A failed upload job cannot be retried. The original is deleted the moment the job dies, so
  the only honest recovery is picking the file again — the retry button is hidden for uploads
  and the API refuses.
- If the Agent's hash of the original disagrees with the browser's, the job fails permanently
  instead of retrying: the bytes and the identity no longer match, and every retry would
  reproduce the same mismatch.
- Uploads reuse the entire second half of the ingest pipeline (ADR-0001) — normalise, thumbnail,
  register, deduplicate — so an uploaded Video is indistinguishable from a downloaded one
  afterwards, including its `moov`-at-the-front Playable.
- The browser holds the whole upload in one tab: closing it mid-flight loses the progress. The
  page warns before unloading, which is as much as a page can do.
