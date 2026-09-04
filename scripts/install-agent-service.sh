#!/usr/bin/env bash
#
# Registers the Agent with launchd so it starts at login and restarts if it dies.
#
# The plist is generated rather than committed because it needs absolute paths, and this
# repo is expected to move to a different Mac — a committed plist would carry this machine's
# paths with it. Re-run this script on the new machine instead of editing anything.
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="io.felixli.kel-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/kel-agent"

if [[ ! -f "$REPO/apps/agent/.env" ]]; then
  echo "apps/agent/.env is missing — copy apps/agent/.env.example and fill it in first." >&2
  exit 1
fi

# launchd starts with a near-empty PATH, so Homebrew's yt-dlp and ffmpeg are invisible unless
# we hand it the PATH this shell can see. This is the single most common reason the service
# starts and then fails every job with "启动 yt-dlp 失败".
PNPM_BIN="$(command -v pnpm)"
RESOLVED_PATH="$(dirname "$PNPM_BIN"):$(dirname "$(command -v yt-dlp || echo /opt/homebrew/bin/x)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PNPM_BIN</string>
    <string>-F</string>
    <string>@kel/agent</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$RESOLVED_PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Do not respawn faster than this; a misconfigured Agent would otherwise spin. -->
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/agent.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

cat <<EOF

Installed $LABEL

  logs      tail -f $LOG_DIR/agent.log
  restart   launchctl kickstart -k gui/$UID/$LABEL
  stop      launchctl bootout gui/$UID/$LABEL
  plist     $PLIST

Note: the Agent only runs while you are logged in, and a sleeping Mac downloads nothing —
the app says "已排队 · 家里的机器没开机" for exactly this case, which is the truth.
EOF
