#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PLIST_LABEL = 'com.se-notebook-embed';
const PLIST_PATH = `${process.env.HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist`;
const PROJECT_DIR = path.resolve(__dirname, '..');
const NODE_PATH = process.execPath;
const EMBED_SCRIPT = path.join(PROJECT_DIR, 'embed-server.js');
// Logs live under ~/Library/Logs (a stable, always-available local path).
// The project root is on OneDrive CloudStorage, which launchd can't reliably
// open for stdout/stderr — that surfaced as exit code 78 (EX_CONFIG).
const LOG_DIR = path.join(process.env.HOME, 'Library', 'Logs', 'se-notebook');
const LOG_OUT = path.join(LOG_DIR, 'embed-server.log');
const LOG_ERR = path.join(LOG_DIR, 'embed-server-error.log');

const args = process.argv.slice(2);

if (args.includes('--remove')) {
  try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`); fs.unlinkSync(PLIST_PATH); console.log('Service removed.'); } catch (e) { console.error(e.message); }
  process.exit(0);
}
if (args.includes('--status')) {
  try { console.log(execSync(`launchctl list | grep ${PLIST_LABEL}`).toString().trim()); } catch { console.log('Not running or not installed.'); }
  process.exit(0);
}

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key><array><string>${NODE_PATH}</string><string>${EMBED_SCRIPT}</string></array>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG_OUT}</string>
  <key>StandardErrorPath</key><string>${LOG_ERR}</string>
</dict></plist>`;

fs.writeFileSync(PLIST_PATH, plist);
execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
execSync(`launchctl load "${PLIST_PATH}"`);
console.log('Embed server installed as persistent service. Auto-starts on login.');
console.log('Logs:', LOG_OUT);
