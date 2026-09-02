#!/bin/bash
# Install (or refresh) the host-side backup job.
#
# Copies backup-runner.js OUT of the project folder into ~/se-notebook-data
# before scheduling it. The project lives inside OneDrive, which dehydrates
# files it thinks are idle — a cloud-only placeholder is not something launchd
# can execute at 23:00. The data dir is deliberately outside any sync client,
# so the copy there always exists as real bytes.
#
# launchd runs it every 15 minutes; the runner itself decides whether a backup
# is due from the schedule configured in Settings. So this only needs running
# again when the runner's own code changes — not when the schedule does.
#
# Usage: npm run backup:install
set -euo pipefail

DATA_DIR="${SE_NOTEBOOK_DB_DIR:-$HOME/se-notebook-data}"
SRC="$(cd "$(dirname "$0")" && pwd)/backup-runner.js"
DEST="$DATA_DIR/backup-runner.js"
LABEL="com.se-notebook-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Prefer the pinned Homebrew node the other agents use, else whatever is on PATH.
NODE_BIN="/opt/homebrew/opt/node@22/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || { echo "ERROR: node not found" >&2; exit 1; }

mkdir -p "$DATA_DIR"
cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "installed runner: $DEST"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <!-- Runs the copy in the data dir, NOT the one in the project folder:
       OneDrive can dehydrate the project copy into a placeholder that will
       not execute. Ticks every 15 minutes and no-ops unless the schedule in
       Settings says a backup is due, so changing the schedule needs no
       launchctl reload. -->
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DEST</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DATA_DIR</string>

  <key>StartInterval</key>
  <integer>900</integer>

  <key>StandardOutPath</key>
  <string>$DATA_DIR/backup.log</string>
  <key>StandardErrorPath</key>
  <string>$DATA_DIR/backup-error.log</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST" >/dev/null
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "scheduled: $LABEL (every 15 min; the runner decides if a backup is due)"
echo
echo "Backup folder and schedule are configured in the app under Settings."
