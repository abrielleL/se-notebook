// ---------------------------------------------------------------------------
// Backup configuration: shared shape, validation, and the on-disk mirror.
//
// The server can only see what Docker mounts — /data (the host's
// ~/se-notebook-data) and the uploads folder. It therefore CANNOT write a
// backup to an arbitrary host path like an external drive. So the app owns the
// *configuration* and a host-side runner owns the *execution*:
//
//   Settings UI -> app_settings table -> /data/backup-config.json
//                                              |
//                            backup-runner.js on the host (via launchd)
//                                              |
//                                     any path the user can write
//
// The runner writes its outcome back to /data/backup-status.json, which is how
// Settings can show when the last backup ran and whether it worked. Mirroring
// to a file rather than having the runner read SQLite keeps the runner free of
// a native better-sqlite3 dependency outside the container.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const KEY = 'backup';
const DATA_DIR = process.env.SE_NOTEBOOK_DB_DIR || path.join(__dirname, '..', 'db');
const CONFIG_PATH = path.join(DATA_DIR, 'backup-config.json');
const STATUS_PATH = path.join(DATA_DIR, 'backup-status.json');

const FREQUENCIES = ['off', 'hourly', 'daily', 'weekly'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The default destination is the data dir's own backups folder: it already
// exists, it's outside OneDrive, and it's the one path the server itself can
// also write to (so "Back up now" is instant there).
const DEFAULTS = {
  frequency: 'daily',
  hour: 23,
  minute: 0,
  weekday: 0,            // only meaningful when frequency === 'weekly'
  path: '~/se-notebook-data/backups',
  keep: 14
};

const clampInt = (v, lo, hi, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// Reject paths that can't be a real backup directory. Deliberately permissive
// about *where* — the whole point is that the SE can pick any disk — but a
// relative path would resolve against whatever the runner's cwd happens to be,
// which is not something anyone should have to reason about.
function validatePath(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { error: 'Backup folder is required.' };
  if (raw.includes('\0')) return { error: 'Backup folder contains an invalid character.' };
  if (!raw.startsWith('/') && !raw.startsWith('~')) {
    return { error: 'Use an absolute path (starting with / or ~), so it does not depend on where the backup job runs from.' };
  }
  // Guard the one destination that would defeat the purpose: writing snapshots
  // next to the live database means one disk failure takes both.
  const normalized = raw.replace(/\/+$/, '');
  if (/(^|\/)se-notebook\.db$/.test(normalized)) {
    return { error: 'That is the database file, not a folder.' };
  }
  return { path: normalized };
}

function validate(input = {}) {
  const frequency = FREQUENCIES.includes(input.frequency) ? input.frequency : DEFAULTS.frequency;
  const { path: cleanPath, error } = validatePath(
    input.path == null || input.path === '' ? DEFAULTS.path : input.path
  );
  if (error) return { error };

  return {
    config: {
      frequency,
      hour: clampInt(input.hour, 0, 23, DEFAULTS.hour),
      minute: clampInt(input.minute, 0, 59, DEFAULTS.minute),
      weekday: clampInt(input.weekday, 0, 6, DEFAULTS.weekday),
      path: cleanPath,
      keep: clampInt(input.keep, 1, 365, DEFAULTS.keep)
    }
  };
}

function read() {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY);
  if (!row) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULTS };
  }
}

// Persist to SQLite (source of truth) and mirror to the file the host runner
// reads. A failed mirror is reported rather than swallowed: silently not
// writing it is exactly how the last backup job broke.
function write(config) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(KEY, JSON.stringify(config));

  let mirrorError = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  } catch (e) {
    mirrorError = e.message;
  }
  return { mirrorError };
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// Ask the host runner to back up on its next tick. Used when the destination
// is outside the container's mounts and the server can't do it itself.
function requestRun() {
  const config = read();
  const next = { ...config, run_now_requested_at: new Date().toISOString() };
  const { mirrorError } = write(next);
  return { mirrorError };
}

function clearRunRequest() {
  const config = read();
  delete config.run_now_requested_at;
  return write(config);
}

// Does this destination fall inside a path the container itself can write to?
// If so the server can take the snapshot immediately instead of deferring.
function resolveInContainer(configPath) {
  const home = process.env.HOME || '/root';
  const expanded = configPath.startsWith('~')
    ? path.join(home, configPath.slice(1))
    : configPath;
  // On the host, ~/se-notebook-data is mounted at /data.
  const hostDataDir = path.join(home, 'se-notebook-data');
  if (expanded === hostDataDir || expanded.startsWith(hostDataDir + '/')) {
    return path.join('/data', expanded.slice(hostDataDir.length));
  }
  if (expanded === '/data' || expanded.startsWith('/data/')) return expanded;
  return null;
}

module.exports = {
  KEY, DEFAULTS, FREQUENCIES, WEEKDAYS,
  CONFIG_PATH, STATUS_PATH, DATA_DIR,
  validate, read, write, readStatus, requestRun, clearRunRequest, resolveInContainer
};
