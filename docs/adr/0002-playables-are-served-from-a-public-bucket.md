# Playables are served from a public bucket with unguessable keys

The R2 bucket holding Playables is public, on a custom domain, and every object key contains
128 bits of randomness. Nothing checks who you are before serving the video — knowing the URL
is the authorisation. This looks careless and is deliberate.

Playback has to work for clients that cannot log in. AirPlay and Chromecast hand the media URL
to the television, which fetches it itself and sends none of the browser's cookies, so
cookie-gated media is a dead end for the casting we intend to support later. The alternatives
each cost something we are not paying: `is_timed_hmac_valid_v0()` (real expiring signatures,
still fully CDN-cached, zero application code) needs a Pro plan; R2 presigned URLs bypass the
Cloudflare cache entirely, which forfeits the speed this design is built around; and a Worker
proxy means hand-rolling Range, 206, ETag and conditional requests on the hot path.

The library is nursery rhymes for one family, not secrets, and R2 egress is free — so a leaked
URL costs approximately nothing. Site login, upload, deletion and Progress remain gated
normally; only the video bytes are open.

## Consequences

- The `r2.dev` development subdomain must stay disabled, or it becomes an unguarded second
  door into the same bucket.
- A `robots.txt` at the bucket root keeps crawlers out. A `X-Robots-Tag: noindex` response
  header rule would be stronger — it also covers a URL someone links to from elsewhere — but
  writing one needs `Zone:Rulesets:Edit`, which wrangler's OAuth token does not carry, so it
  cannot be part of the automated setup. Worth adding by hand if the library ever stops being
  only nursery rhymes.
- Revoking a leaked URL means copying the object to a new key and deleting the old one.
- Upgrading to real signed URLs later is additive: the key layout does not change, only a WAF
  rule and the URL-building function.
