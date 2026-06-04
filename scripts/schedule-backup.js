// ============================================================
// schedule-backup.js — Install a macOS launchd schedule for backup-db.js
// Requires: nothing (pure Node.js built-ins only)
//
// Usage:
//   node scripts/schedule-backup.js           <- write and load the plist
//   node scripts/schedule-backup.js --remove  <- unload and delete the plist
//   node scripts/schedule-backup.js --now     <- run a backup immediately
//
// Schedule:
//   Daily database backup — every day at 11:00pm
// ============================================================

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const logDir       = path.join(PROJECT_ROOT, 'logs');
const agentDir     = path.join(os.homedir(), 'Library', 'LaunchAgents');
const backupJs     = path.join(__dirname, 'backup-db.js');

const LABEL = 'com.se-notebook-backup';
const PLIST = path.join(agentDir, LABEL + '.plist');

const SCHEDULE = `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>23</integer>
    <key>Minute</key><integer>0</integer>
  </dict>`;

function resolveNodePath() {
  try {
    return execSync('which node', { encoding: 'utf-8' }).trim();
  } catch {
    console.error('ERROR: could not resolve `node` via `which node`. Is node on PATH?');
    process.exit(1);
  }
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPlist({ label, args, scheduleXml, stdout, stderr, workingDir }) {
  const argsXml = args.map(a => '    <string>' + xmlEscape(a) + '</string>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDir)}</string>
${scheduleXml}
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderr)}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

function runLaunchctl(args, { allowFail = false } = {}) {
  try {
    execSync('launchctl ' + args, { stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    if (!allowFail) {
      console.error('  launchctl ' + args + ' failed: ' + (err.stderr ? err.stderr.toString().trim() : err.message));
    }
    return { ok: false, err };
  }
}

function install() {
  fs.mkdirSync(logDir,   { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  if (!fs.existsSync(backupJs)) {
    console.error('ERROR: backup-db.js not found at ' + backupJs);
    process.exit(1);
  }

  const nodePath = resolveNodePath();
  const plist = buildPlist({
    label:       LABEL,
    args:        [nodePath, backupJs],
    scheduleXml: SCHEDULE,
    stdout:      path.join(logDir, 'backup.log'),
    stderr:      path.join(logDir, 'backup-error.log'),
    workingDir:  PROJECT_ROOT,
  });

  // Unload first in case it's already loaded.
  runLaunchctl('unload ' + JSON.stringify(PLIST), { allowFail: true });

  fs.writeFileSync(PLIST, plist, 'utf-8');

  const r = runLaunchctl('load ' + JSON.stringify(PLIST));
  if (!r.ok) {
    console.error('\nPlist failed to load. Check launchctl error above.');
    process.exit(1);
  }

  console.log('\n  ✓ Daily database backup — every day at 11:00pm');
  console.log('  Logs: ' + logDir + '/backup.log');
  console.log('');
  console.log('  Run a backup now:    node scripts/schedule-backup.js --now');
  console.log('  Remove the schedule: node scripts/schedule-backup.js --remove');
  console.log('');
}

function remove() {
  runLaunchctl('unload ' + JSON.stringify(PLIST), { allowFail: true });
  if (fs.existsSync(PLIST)) {
    fs.unlinkSync(PLIST);
    console.log('  removed: ' + PLIST);
  } else {
    console.log('  not present: ' + PLIST);
  }
  console.log('');
}

function now() {
  console.log('  Running backup now…');
  execSync(JSON.stringify(resolveNodePath()) + ' ' + JSON.stringify(backupJs), { stdio: 'inherit' });
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('ERROR: schedule-backup.js targets macOS launchd. Detected platform: ' + process.platform);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.includes('--remove'))    remove();
  else if (args.includes('--now'))  now();
  else if (args.length === 0)       install();
  else {
    console.error('ERROR: unknown flag(s): ' + args.join(' '));
    console.error('Usage:');
    console.error('  node scripts/schedule-backup.js           install and load the plist');
    console.error('  node scripts/schedule-backup.js --remove  unload and delete the plist');
    console.error('  node scripts/schedule-backup.js --now     run a backup immediately');
    process.exit(1);
  }
}

main();
