# Ingest runs on a machine at home, not on Cloudflare

Everything else in this app lives on Cloudflare, so the obvious guess is that downloading a
YouTube video does too. It cannot. Workers have no subprocesses, no ffmpeg and a hard CPU
ceiling, and YouTube's bot checks are aggressive against Cloudflare's egress IPs — a Container
running yt-dlp would work for a while and then start demanding cookies or a proxy, forever.
So the Agent runs on a machine at home: it pulls Ingest Jobs over plain HTTP, runs yt-dlp and
ffmpeg locally, and uploads the finished Playable straight to R2. Cloudflare keeps the queue,
the metadata, auth and playback.

## Consequences

- Submitting and completing are necessarily asynchronous, and the UI must say so honestly
  ("queued — the machine at home is offline") rather than spinning.
- The Agent is behind NAT with no public address, so task distribution can only be pull-based.
  Cloudflare can never call the Agent.
- A crashed Agent must not strand a job: claims are leased with a timeout and reclaimed.
- Manual uploads take the same second half of the pipeline (normalise → Playable → register),
  because browsers cannot encode H.264 either. One state machine covers both Sources.
