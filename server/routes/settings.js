const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const backup = require('../lib/backupConfig');

const router = express.Router();

// Recent snapshots at the configured destination, newest first — but only when
// that destination is inside the container's mounts. For a host path we can't
// even list it, so the runner reports what it found via backup-status.json.
function listSnapshots(configPath) {
  const inContainer = backup.resolveInContainer(configPath);
  if (!inContainer) return { readable: false, snapshots: [] };
  try {
    const files = fs.readdirSync(inContainer)
      .filter(f => f.startsWith('se-notebook-') && f.endsWith('.db'))
      .map(f => {
        const st = fs.statSync(path.join(inContainer, f));
        return { name: f, size: st.size, modified: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.modified < b.modified ? 1 : -1));
    return { readable: true, snapshots: files.slice(0, 10), total: files.length };
  } catch (e) {
    return { readable: false, snapshots: [], error: e.message };
  }
}

router.get('/backup', (_req, res) => {
  const config = backup.read();
  res.json({
    config,
    status: backup.readStatus(),
    // Tells the UI whether "Back up now" will be immediate or deferred, so it
    // can say which rather than leaving the user guessing.
    writableHere: Boolean(backup.resolveInContainer(config.path)),
    ...listSnapshots(config.path)
  });
});

router.put('/backup', (req, res) => {
  const { config, error } = backup.validate(req.body);
  if (error) return res.status(400).json({ error });

  const { mirrorError } = backup.write(config);
  if (mirrorError) {
    return res.status(500).json({
      error: `Saved, but could not write the config the backup job reads (${mirrorError}). The schedule will not take effect.`
    });
  }
  res.json({ config, status: backup.readStatus(), writableHere: Boolean(backup.resolveInContainer(config.path)) });
});

// Back up now. Immediate when the destination is inside the mounts; otherwise
// flag it for the host runner's next tick and say so.
router.post('/backup/run', async (req, res) => {
  const config = backup.read();
  const dest = backup.resolveInContainer(config.path);

  if (!dest) {
    const { mirrorError } = backup.requestRun();
    if (mirrorError) return res.status(500).json({ error: `Could not queue the backup: ${mirrorError}` });
    return res.json({
      queued: true,
      message: `${config.path} is outside this app's reach, so the backup job will take it on its next check (within 15 minutes).`
    });
  }

  try {
    fs.mkdirSync(dest, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = path.join(dest, `se-notebook-${stamp}.db`);

    // SQLite's own online backup API — safe while the app is writing, unlike a
    // file copy, which can capture a torn page mid-transaction.
    await db.backup(file);

    // Verify the snapshot, and delete it if it isn't sound: a backup that
    // fails verification must never sit there looking restorable.
    const Database = require('better-sqlite3');
    let ok, accounts = 0;
    try {
      const snap = new Database(file);
      ok = snap.prepare('PRAGMA integrity_check').get().integrity_check;
      if (ok === 'ok') accounts = snap.prepare('SELECT COUNT(*) n FROM accounts').get().n;
      // Fold anything the open left in the WAL back into the file, so the
      // snapshot is one self-contained .db. Without this, every backup grows
      // a -wal/-shm pair and a restore has to guess whether they matter.
      snap.pragma('wal_checkpoint(TRUNCATE)');
      snap.close();
    } catch (e) {
      discard(file);
      return res.status(500).json({ error: `Snapshot could not be verified: ${e.message}` });
    }
    clearSidecars(file);
    if (ok !== 'ok') {
      discard(file);
      return res.status(500).json({ error: `Snapshot failed integrity check (${ok}); discarded.` });
    }

    prune(dest, config.keep);

    const status = {
      last_run: new Date().toISOString(),
      ok: true,
      file: path.basename(file),
      accounts,
      by: 'app',
      path: config.path
    };
    fs.writeFileSync(backup.STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

    res.json({ queued: false, status, ...listSnapshots(config.path) });
  } catch (e) {
    res.status(500).json({ error: `Backup failed: ${e.message}` });
  }
});

// A snapshot's WAL/SHM sidecars exist only because we opened it to verify it.
function clearSidecars(file) {
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(file + suffix); } catch { /* absent is fine */ }
  }
}
function discard(file) {
  clearSidecars(file);
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

function prune(dir, keep) {
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('se-notebook-') && f.endsWith('.db'))
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const { f } of files.slice(keep)) discard(path.join(dir, f));
}

module.exports = router;
