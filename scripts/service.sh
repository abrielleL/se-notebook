#!/usr/bin/env bash
# SE/notebook LaunchAgent helper.
# Usage: bash scripts/service.sh {install|uninstall|start|stop|restart|status|logs}

set -euo pipefail

LABEL="com.senotebook"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$PROJECT_DIR/server/logs"
STDOUT_LOG="$LOG_DIR/server.out.log"
STDERR_LOG="$LOG_DIR/server.err.log"

# Find node. Prefer node@22 (better-sqlite3 prebuilt support), fall back to whatever's on PATH.
find_node() {
  if [ -x "/opt/homebrew/opt/node@22/bin/node" ]; then
    echo "/opt/homebrew/opt/node@22/bin/node"
  elif command -v node >/dev/null 2>&1; then
    command -v node
  else
    echo ""
  fi
}

domain="gui/$(id -u)"
service_target="${domain}/${LABEL}"

write_plist() {
  local node_bin
  node_bin="$(find_node)"
  if [ -z "$node_bin" ]; then
    echo "Error: node not found. Install Node 22 (e.g. brew install node@22) and re-run." >&2
    exit 1
  fi

  mkdir -p "$LOG_DIR"
  mkdir -p "$(dirname "$PLIST_PATH")"

  local node_dir
  node_dir="$(dirname "$node_bin")"

  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${node_bin}</string>
    <string>${PROJECT_DIR}/server/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${node_dir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${STDOUT_LOG}</string>

  <key>StandardErrorPath</key>
  <string>${STDERR_LOG}</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST
  echo "Wrote ${PLIST_PATH}"
  echo "  Node:    ${node_bin}"
  echo "  Project: ${PROJECT_DIR}"
}

is_loaded() {
  launchctl print "$service_target" >/dev/null 2>&1
}

cmd_install() {
  write_plist
  if is_loaded; then
    launchctl bootout "$service_target" >/dev/null 2>&1 || true
  fi
  launchctl bootstrap "$domain" "$PLIST_PATH"
  launchctl enable "$service_target" >/dev/null 2>&1 || true
  echo "Service installed and started. Open http://localhost:3001"
}

cmd_uninstall() {
  if is_loaded; then
    launchctl bootout "$service_target" || true
  fi
  if [ -f "$PLIST_PATH" ]; then
    rm -f "$PLIST_PATH"
    echo "Removed $PLIST_PATH"
  else
    echo "Service was not installed."
  fi
}

cmd_start() {
  if ! is_loaded; then
    launchctl bootstrap "$domain" "$PLIST_PATH"
  fi
  launchctl kickstart "$service_target"
  echo "Started."
}

cmd_stop() {
  if is_loaded; then
    launchctl bootout "$service_target" || true
    echo "Stopped."
  else
    echo "Service not loaded."
  fi
}

cmd_restart() {
  if is_loaded; then
    launchctl kickstart -k "$service_target"
  else
    launchctl bootstrap "$domain" "$PLIST_PATH"
  fi
  echo "Restarted."
}

cmd_status() {
  if is_loaded; then
    launchctl print "$service_target" | head -25
  else
    echo "Service not loaded. Run: npm run service:install"
  fi
}

cmd_logs() {
  echo "--- ${STDERR_LOG} (last 40) ---"
  tail -n 40 "$STDERR_LOG" 2>/dev/null || echo "(no stderr log yet)"
  echo
  echo "--- ${STDOUT_LOG} (last 40) ---"
  tail -n 40 "$STDOUT_LOG" 2>/dev/null || echo "(no stdout log yet)"
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  *)
    echo "Usage: $0 {install|uninstall|start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac
