#!/usr/bin/env bash
#
# Creates the Cloudflare resources this app needs. Safe to re-run: every step tolerates the
# resource already existing, and nothing here rotates a secret that something else depends on.
#
#   ./scripts/setup-cloudflare.sh
#
# Requires `wrangler login` to have been run. Everything except the R2 API token for the Agent
# is done here — that one genuinely needs the dashboard, see the end of the output.
#
set -uo pipefail

ZONE_NAME="felixli.io"
MEDIA_HOST="media.felixli.io"
MEDIA_BUCKET="kel-media"
PRIVATE_BUCKET="kel-private"
D1_NAME="kel"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$REPO/apps/worker/wrangler.jsonc"
cd "$REPO/apps/worker" || exit 1
WRANGLER="npx wrangler"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

step "1/7  Account"
WHOAMI="$($WRANGLER whoami 2>&1)"
grep -q 'You are logged in' <<<"$WHOAMI" || die "Not logged in. Run: cd apps/worker && npx wrangler login"
ACCOUNT_ID="$(grep -oE '[0-9a-f]{32}' <<<"$WHOAMI" | head -1)"
[[ -n "$ACCOUNT_ID" ]] || die "Could not read the account ID out of \`wrangler whoami\`."
ok "account $ACCOUNT_ID"

# The zone ID is needed to attach the R2 custom domain, and wrangler has no `zone` command.
# Reuse the OAuth token it already stored — its scopes include zone:read.
TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  for f in "$HOME/Library/Preferences/.wrangler/config/default.toml" \
           "$HOME/.config/.wrangler/config/default.toml" \
           "$HOME/.wrangler/config/default.toml"; do
    [[ -f "$f" ]] && TOKEN="$(sed -n 's/^oauth_token *= *"\(.*\)"$/\1/p' "$f" | head -1)" && break
  done
fi
[[ -n "$TOKEN" ]] || die "No API token found. Set CLOUDFLARE_API_TOKEN or run \`wrangler login\`."

api() { curl -sS -H "Authorization: Bearer $TOKEN" "https://api.cloudflare.com/client/v4/$1" "${@:2}"; }

ZONE_ID="$(api "zones?name=$ZONE_NAME" | jq -r '.result[0].id // empty')"
[[ -n "$ZONE_ID" ]] || die "Zone $ZONE_NAME is not on this account. Add it in Cloudflare first."
ok "zone $ZONE_NAME → $ZONE_ID"

step "2/7  D1 database"
if D1_ID="$(api "accounts/$ACCOUNT_ID/d1/database?name=$D1_NAME" | jq -r ".result[] | select(.name==\"$D1_NAME\") | .uuid")" && [[ -n "$D1_ID" ]]; then
  ok "$D1_NAME already exists"
else
  $WRANGLER d1 create "$D1_NAME" >/dev/null 2>&1
  D1_ID="$(api "accounts/$ACCOUNT_ID/d1/database?name=$D1_NAME" | jq -r ".result[] | select(.name==\"$D1_NAME\") | .uuid")"
  [[ -n "$D1_ID" ]] || die "Created $D1_NAME but could not read its id back."
  ok "created $D1_NAME"
fi

# Patch the config rather than asking a human to copy a UUID accurately.
CURRENT="$(sed -n 's/.*"database_id" *: *"\([^"]*\)".*/\1/p' "$CONFIG" | head -1)"
if [[ "$CURRENT" == "$D1_ID" ]]; then
  ok "wrangler.jsonc already points at it"
else
  perl -pi -e "s/(\"database_id\"\s*:\s*\")[^\"]*(\")/\${1}$D1_ID\${2}/" "$CONFIG"
  ok "wrangler.jsonc database_id ← $D1_ID"
fi

step "3/7  R2 buckets"
# kel-media is public and serves the Playables; kel-private holds the nightly exports and must
# never be reachable from the web. Two buckets, because one public bucket holding both would
# publish the whole library's metadata. See docs/adr/0002.
EXISTING="$(api "accounts/$ACCOUNT_ID/r2/buckets" | jq -r '.result.buckets[]?.name')"
for b in "$MEDIA_BUCKET" "$PRIVATE_BUCKET"; do
  if grep -qx "$b" <<<"$EXISTING"; then
    ok "$b already exists"
  else
    $WRANGLER r2 bucket create "$b" >/dev/null 2>&1 && ok "created $b" || warn "could not create $b"
  fi
done

step "4/7  Public access for $MEDIA_BUCKET"
# Exactly one public door: the custom domain. The r2.dev URL is a second one, so close it.
DEV_URL_STATE="$(api "accounts/$ACCOUNT_ID/r2/buckets/$MEDIA_BUCKET/domains/managed" | jq -r '.result.enabled // "unknown"')"
if [[ "$DEV_URL_STATE" == "true" ]]; then
  $WRANGLER r2 bucket dev-url disable "$MEDIA_BUCKET" --force >/dev/null 2>&1 \
    && ok "r2.dev disabled" || warn "could not disable r2.dev — do it in the dashboard"
else
  ok "r2.dev already disabled"
fi

ATTACHED="$(api "accounts/$ACCOUNT_ID/r2/buckets/$MEDIA_BUCKET/domains/custom" | jq -r '.result.domains[]?.domain')"
if grep -qx "$MEDIA_HOST" <<<"$ATTACHED"; then
  ok "$MEDIA_HOST already connected"
else
  $WRANGLER r2 bucket domain add "$MEDIA_BUCKET" \
    --domain "$MEDIA_HOST" --zone-id "$ZONE_ID" --min-tls 1.2 --force >/dev/null 2>&1 \
    && ok "connected $MEDIA_HOST" || warn "could not connect $MEDIA_HOST — do it in the dashboard"
fi

# Keeping media out of search engines. A response-header Transform Rule would be stronger, but
# writing one needs Zone:Rulesets:Edit and wrangler's OAuth token does not have it. A robots.txt
# at the bucket root is served by the custom domain and needs no extra credential.
ROBOTS="$(mktemp)"
printf 'User-agent: *\nDisallow: /\n' > "$ROBOTS"
$WRANGLER r2 object put "$MEDIA_BUCKET/robots.txt" \
  --file "$ROBOTS" --content-type "text/plain" --remote >/dev/null 2>&1 \
  && ok "robots.txt uploaded" || warn "could not upload robots.txt"
rm -f "$ROBOTS"

step "5/7  Worker secrets"
# Only create what is missing. Rotating AGENT_TOKEN on a re-run would silently break a working
# Agent, which is a much worse failure than a stale secret.
HAVE="$($WRANGLER secret list 2>/dev/null | jq -r '.[]?.name')"
NEW_AGENT_TOKEN=""
for name in SESSION_SECRET AGENT_TOKEN; do
  if grep -qx "$name" <<<"$HAVE"; then
    ok "$name already set"
  else
    value="$(openssl rand -hex 32)"
    printf '%s' "$value" | $WRANGLER secret put "$name" >/dev/null 2>&1 \
      && ok "$name generated" || die "failed to set $name"
    [[ "$name" == "AGENT_TOKEN" ]] && NEW_AGENT_TOKEN="$value"
  fi
done
if grep -qx APP_PASSWORD_HASH <<<"$HAVE"; then
  ok "APP_PASSWORD_HASH already set"
else
  warn "APP_PASSWORD_HASH is not set — run \`pnpm gen-password\` (step 7 below)"
fi

step "6/7  Schema and deploy"
echo "  Run these from the repo root:"
echo "      pnpm db:migrate:remote"
echo "      pnpm deploy"

step "7/7  What is left for you"
cat <<EOF
  a. The app password. It is printed once and stored nowhere:
         pnpm gen-password
     Then paste the hash into: cd apps/worker && npx wrangler secret put APP_PASSWORD_HASH
     Do not swap it for a memorable password — docs/adr/0003 explains why.

  b. The R2 API token for the Agent. This is the one thing with no API:
         Cloudflare dashboard → R2 → Manage API Tokens → Create
         Permission: Object Read & Write
         Bucket:     $MEDIA_BUCKET  ONLY  (the Agent must not reach $PRIVATE_BUCKET)
     Put the Access Key ID and Secret into apps/agent/.env.

  Then apps/agent/.env needs:
      KEL_R2_ACCOUNT_ID=$ACCOUNT_ID
EOF
if [[ -n "$NEW_AGENT_TOKEN" ]]; then
  echo "      KEL_AGENT_TOKEN=$NEW_AGENT_TOKEN"
  echo
  warn "That token is shown only now. Losing it means re-running \`wrangler secret put AGENT_TOKEN\`."
else
  echo "      KEL_AGENT_TOKEN=<the value already in your apps/agent/.env>"
fi
echo
