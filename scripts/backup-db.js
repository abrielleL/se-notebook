// ============================================================
// backup-db.js — Snapshot the SE notebook SQLite database.
// Requires: nothing (pure Node.js built-ins only)
//
// Copies the live database to backups/notebook_YYYY-MM-DD_HH-MM.sqlite
// and keeps only the most recent 30 backups (oldest deleted first).
//
// NOT the scheduled backup. launchd (com.se-notebook-backup) runs
// ~/se-notebook-data/backup.sh instead, which uses sqlite3's own .backup plus
// PRAGMA integrity_check -- safe against a live database, where the file copy
// below can capture a torn file mid-transaction. This script stays for
// ad-hoc snapshots.
//
// The DB path must be resolved the same way server/db/database.js resolves it.
// It used to be hardcoded to server/db/se-notebook.db; when the database moved
// to ~/se-notebook-data on 2026-08-20 (OneDrive corrupted it in place) this
// script kept pointing at the old location and the nightly job failed silently
// for 13 days -- "ERROR: database not found" into a log nobody reads.
//
// Because the DB runs in WAL mode, the -wal and -shm sidecar files are copied
// alongside the snapshot when present, so the backup is restorable.
//
// Usage:
//   node scripts/backup-db.js
// ============================================================

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// Mirrors database.js: SE_NOTEBOOK_DB_DIR wins, else the default data dir.
const DB_DIR       = process.env.SE_NOTEBOOK_DB_DIR
  || path.join(os.homedir(), 'se-notebook-data');
const DB_PATH      = path.join(DB_DIR, 'se-notebook.db');
const BACKUP_DIR   = path.join(PROJECT_ROOT, 'backups');
const KEEP         = 30;
const PREFIX       = 'notebook_';
const EXT          = '.sqlite';

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

function prune() {
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith(PREFIX) && f.endsWith(EXT))
    .sort(); // names are timestamp-ordered, so lexical sort == chronological

  while (backups.length > KEEP) {
    const oldest = backups.shift();
    const base = path.join(BACKUP_DIR, oldest);
    for (const suffix of ['', '-wal', '-shm']) {
      const f = base + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    console.log('  pruned: ' + oldest);
  }
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('ERROR: database not found at ' + DB_PATH);
    process.exit(1);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const destName = PREFIX + timestamp() + EXT;
  const destPath = path.join(BACKUP_DIR, destName);

  // Copy the main DB plus any WAL/SHM sidecars (WAL mode).
  fs.copyFileSync(DB_PATH, destPath);
  for (const suffix of ['-wal', '-shm']) {
    const src = DB_PATH + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, destPath + suffix);
  }

  const sizeKb = (fs.statSync(destPath).size / 1024).toFixed(1);
  console.log('  ✓ backup: ' + destName + ' (' + sizeKb + ' KB)');

  prune();

  const count = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(PREFIX) && f.endsWith(EXT)).length;
  console.log('  backups retained: ' + count + ' / ' + KEEP);
}

main();
