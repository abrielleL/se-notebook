const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');

const router = express.Router();

router.get('/accounts/:id/crm-snapshots', (req, res) => {
  const snapshots = db.prepare(`
    SELECT * FROM crm_snapshots
    WHERE account_id = ? AND deleted_at IS NULL
    ORDER BY generated_at DESC, id DESC
  `).all(req.params.id);
  res.json(snapshots);
});

router.post('/accounts/:id/crm-snapshots', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const text = (req.body && req.body.snapshot_text ? String(req.body.snapshot_text) : '').trim();
  if (!text) return res.status(400).json({ error: 'snapshot_text required' });

  const truncated = text.slice(0, 255);
  const id = uuid();
  db.prepare(`
    INSERT INTO crm_snapshots (id, account_id, snapshot_text)
    VALUES (?, ?, ?)
  `).run(id, req.params.id, truncated);

  const snapshot = db.prepare('SELECT * FROM crm_snapshots WHERE id = ?').get(id);
  res.status(201).json(snapshot);
});

router.delete('/crm-snapshots/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM crm_snapshots WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Snapshot not found' });
  db.prepare('UPDATE crm_snapshots SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
