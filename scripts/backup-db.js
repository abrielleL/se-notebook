// ============================================================
// backup-db.js — Snapshot the SE notebook SQLite database.
// Requires: nothing (pure Node.js built-ins only)
//
// Copies the live database to backups/notebook_YYYY-MM-DD_HH-MM.sqlite
// and keeps only the most recent 30 backups (oldest deleted first).
//
// NOTE: the actual database file is server/db/se-notebook.db (not
// "notebook.sqlite"). Because the DB runs in WAL mode, the -wal and -shm
// sidecar files are copied alongside the snapshot when present, so the
// backup is internally consistent and restorable.
//
// Usage:
//   node scripts/backup-db.js
// ============================================================

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH      = path.join(PROJECT_ROOT, 'server', 'db', 'se-notebook.db');
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
