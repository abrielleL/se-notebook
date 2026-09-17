const express = require('express');
const db = require('../db/database');
const { fold } = require('../lib/aeRoster');

const router = express.Router();

const rowOut = (r) => ({ id: r.id, full_name: r.full_name, sort_order: r.sort_order });

// Rewrite an AE name everywhere it appears on accounts. Both columns are
// touched: ae_name is current, account_executive is where older rows (and the
// new-note form) still keep it.
function renameAcrossAccounts(from, to) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE accounts SET ae_name = ? WHERE lower(trim(ae_name)) = lower(trim(?))').run(to, from);
    db.prepare('UPDATE accounts SET account_executive = ? WHERE lower(trim(account_executive)) = lower(trim(?))').run(to, from);
  });
  tx();
}

router.get('/ae-roster', (_req, res) => {
  res.json(db.prepare('SELECT * FROM ae_roster ORDER BY sort_order ASC, full_name ASC').all().map(rowOut));
});

router.post('/ae-roster', (req, res) => {
  const fullName = (req.body?.full_name || '').trim().replace(/\s+/g, ' ');
  if (!fullName) return res.status(400).json({ error: 'full_name required' });
  const dupe = db.prepare('SELECT id FROM ae_roster WHERE lower(full_name) = lower(?)').get(fullName);
  if (dupe) return res.status(409).json({ error: `${fullName} is already on the roster.` });

  const max = db.prepare('SELECT MAX(sort_order) AS m FROM ae_roster').get().m;
  const info = db.prepare('INSERT INTO ae_roster (full_name, sort_order) VALUES (?, ?)')
    .run(fullName, (max == null ? -1 : max) + 1);
  res.status(201).json(rowOut(db.prepare('SELECT * FROM ae_roster WHERE id = ?').get(info.lastInsertRowid)));
});

// Renaming a roster entry rewrites the name on every account that carries it,
// so a corrected spelling doesn't leave the old one behind on live deals.
router.put('/ae-roster/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM ae_roster WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not on the roster' });

  const fullName = (req.body?.full_name || '').trim().replace(/\s+/g, ' ');
  if (!fullName) return res.status(400).json({ error: 'full_name cannot be empty' });
  const dupe = db.prepare('SELECT id FROM ae_roster WHERE lower(full_name) = lower(?) AND id != ?')
    .get(fullName, existing.id);
  if (dupe) return res.status(409).json({ error: `${fullName} is already on the roster.` });

  db.prepare('UPDATE ae_roster SET full_name = ? WHERE id = ?').run(fullName, existing.id);
  let renamedAccounts = 0;
  if (fold(fullName) !== fold(existing.full_name)) {
    const before = db.prepare(
      'SELECT COUNT(*) AS n FROM accounts WHERE lower(trim(ae_name)) = lower(trim(?)) OR lower(trim(account_executive)) = lower(trim(?))'
    ).get(existing.full_name, existing.full_name).n;
    renameAcrossAccounts(existing.full_name, fullName);
    renamedAccounts = before;
  }
  res.json({ ...rowOut(db.prepare('SELECT * FROM ae_roster WHERE id = ?').get(existing.id)), renamed_accounts: renamedAccounts });
});

// Removing someone from the roster stops their name being offered for
// autofill. It deliberately leaves the AE recorded on existing accounts --
// that is history, not a label, and blanking it would lose who ran the deal.
router.delete('/ae-roster/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM ae_roster WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not on the roster' });
  db.prepare('DELETE FROM ae_roster WHERE id = ?').run(existing.id);
  res.json({ success: true });
});

module.exports = router;
