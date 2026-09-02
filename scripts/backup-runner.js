#!/usr/bin/env node
// ============================================================
// backup-runner.js — the host-side backup job.
//
// Runs OUTSIDE Docker, so it can write to any disk the user can: an external
// drive, iCloud, wherever the Settings page points it. The container can only
// see ~/se-notebook-data, which is why execution lives here and configuration
// lives in the app.
//
//   Settings UI -> app_settings -> ~/se-notebook-data/backup-config.json
//                                            |
//                                    (this script, via launchd)
//                                            |
//                                    <configured path>
//
// launchd fires this every 15 minutes and the script decides whether a backup
// is actually DUE from the configured schedule. That means changing the
// schedule in Settings takes effect on its own — no launchctl reload, nothing
// for the SE to remember. It also means a missed window (laptop asleep at
// 23:00) is caught on the next tick rather than skipped for a day.
//
// Outcome is written to backup-status.json, which is what Settings displays.
// A snapshot that fails PRAGMA integrity_check is deleted, so a bad backup can
// never sit there looking restorable.
//
// Deliberately dependency-free: Node built-ins plus the system sqlite3 binary.
// It must keep working when the project folder is dehydrated by OneDrive or
// node_modules is mid-reinstall.
//
// Usage:
//   node scripts/backup-runner.js          # back up if due
//   node scripts/backup-runner.js --force  # back up now regardless
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.SE_NOTEBOOK_DB_DIR || path.join(os.homedir(), 'se-notebook-data');
const DB_PATH = path.join(DATA_DIR, 'se-notebook.db');
const CONFIG_PATH = path.join(DATA_DIR, 'backup-config.json');
const STATUS_PATH = path.join(DATA_DIR, 'backup-status.json');

const DEFAULTS = {
  frequency: 'daily', hour: 23, minute: 0, weekday: 0,
  path: path.join(DATA_DIR, 'backups'), keep: 14
};

const force = process.argv.includes('--force');
const log = (...a) => console.log(`[backup ${new Date().toISOString()}]`, ...a);

function readJson(p, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch { return { ...fallback }; }
}

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function writeStatus(status) {
  try {
    fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  } catch (e) {
    log('WARN could not write status:', e.message);
  }
}

// Is a backup due? Compares now against the last successful run, and for
// daily/weekly also requires the configured time-of-day to have passed — so
// "daily at 23:00" doesn't fire at 09:00 just because a day has elapsed.
function isDue(config, lastRun, now = new Date()) {
  if (config.frequency === 'off') return { due: false, why: 'schedule is off' };
  if (!lastRun) return { due: true, why: 'no previous backup' };

  const last = new Date(lastRun);
  if (Number.isNaN(last.getTime())) return { due: true, why: 'unreadable last-run time' };
  const minsSince = (now - last) / 60000;

  if (config.frequency === 'hourly') {
    // 55 rather than 60: a 15-minute tick landing at 59 minutes shouldn't
    // push the next backup out by a whole extra tick.
    return minsSince >= 55
      ? { due: true, why: `${Math.round(minsSince)} min since last` }
      : { due: false, why: `only ${Math.round(minsSince)} min since last` };
  }

  // The most recent moment the schedule wanted a backup.
  const target = new Date(now);
  target.setHours(config.hour, config.minute, 0, 0);
  if (config.frequency === 'daily') {
    if (target > now) target.setDate(target.getDate() - 1);
  } else { // weekly
    const back = (now.getDay() - config.weekday + 7) % 7;
    target.setDate(target.getDate() - back);
    if (target > now) target.setDate(target.getDate() - 7);
  }

  return last < target
    ? { due: true, why: `last run ${last.toISOString()} predates ${target.toISOString()}` }
    : { due: false, why: `already ran for the ${config.frequency} window at ${target.toISOString()}` };
}

// A snapshot's WAL/SHM sidecars exist only because we opened it to verify it.
// Leave them behind and a restore has to guess whether they matter.
function clearSidecars(file) {
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(file + suffix); } catch { /* absent is fine */ }
  }
}

// Remove a snapshot we are not willing to vouch for, sidecars included.
function discard(file) {
  clearSidecars(file);
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

function prune(dir, keep) {
  const files = fs.readdirSync(dir)
    .filter(f => /^se-notebook-.*\.db$/.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  let removed = 0;
  for (const { f } of files.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, f)); removed++; } catch { /* best effort */ }
  }
  return removed;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    const msg = `database not found at ${DB_PATH}`;
    log('ERROR', msg);
    writeStatus({ last_attempt: new Date().toISOString(), ok: false, error: msg, by: 'runner' });
    process.exit(1);
  }

  const config = readJson(CONFIG_PATH, DEFAULTS);
  const status = readJson(STATUS_PATH, {});
  const requested = config.run_now_requested_at;

  // A "Back up now" from Settings for an out-of-reach path lands here as a
  // request we haven't serviced yet.
  const alreadyServiced = requested && status.serviced_request === requested;
  const onDemand = force || (requested && !alreadyServiced);

  if (!onDemand) {
    const { due, why } = isDue(config, status.last_run);
    if (!due) { log('skip —', why); return; }
    log('due —', why);
  } else {
    log(force ? 'forced' : 'run requested from Settings');
  }

  const dest = expand(config.path);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dest, `se-notebook-${stamp}.db`);

  try {
    fs.mkdirSync(dest, { recursive: true });

    // sqlite3's own .backup: consistent against a live, WAL-mode database.
    // `cp` can capture a torn file mid-transaction.
    execFileSync('/usr/bin/sqlite3', [DB_PATH, `.backup '${file}'`], { stdio: 'pipe' });

    // Verify before keeping it. Opened read-write on purpose: the snapshot
    // inherits WAL mode, and sqlite3 -readonly can't open a WAL database
    // without its -shm sidecar. So verify normally and clear the sidecars
    // afterwards — a stray -wal next to a backup makes a restore ambiguous.
    let check;
    try {
      check = execFileSync('/usr/bin/sqlite3', [file, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
    } catch (e) {
      // Couldn't even be opened -- it is not a backup. Never leave an
      // unverified file sitting there looking restorable.
      discard(file);
      throw new Error(`snapshot could not be verified: ${(e.stderr ? String(e.stderr).trim() : '') || e.message}`);
    }
    if (check !== 'ok') {
      discard(file);
      throw new Error(`snapshot failed integrity check: ${check}`);
    }
    const accounts = Number(
      execFileSync('/usr/bin/sqlite3', [file, 'SELECT COUNT(*) FROM accounts;'], { encoding: 'utf8' }).trim()
    );
    clearSidecars(file);

    const removed = prune(dest, config.keep);
    const now = new Date().toISOString();
    writeStatus({
      last_run: now,
      last_attempt: now,
      ok: true,
      file: path.basename(file),
      path: config.path,
      accounts,
      pruned: removed,
      by: 'runner',
      ...(requested ? { serviced_request: requested } : {})
    });
    log(`ok: ${file} (${accounts} accounts${removed ? `, pruned ${removed}` : ''})`);
  } catch (e) {
    const msg = e.stderr ? String(e.stderr).trim() || e.message : e.message;
    log('ERROR', msg);
    writeStatus({
      ...status,
      last_attempt: new Date().toISOString(),
      ok: false,
      error: msg,
      path: config.path,
      by: 'runner',
      ...(requested ? { serviced_request: requested } : {})
    });
    process.exit(1);
  }
}

main();
