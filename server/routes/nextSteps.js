const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const opportunities = require('../lib/opportunityStore');

const router = express.Router();

// Anything else — including '' from a cleared picker — is stored as NULL
// (unassigned) rather than rejected, so a bad owner can never block saving
// the step itself.
const OWNERS = new Set(['se', 'ae', 'customer']);
function normalizeOwner(v) {
  const o = String(v == null ? '' : v).trim().toLowerCase();
  return OWNERS.has(o) ? o : null;
}

router.get('/:accountId', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM next_steps WHERE account_id = ? ORDER BY completed, created_at
  `).all(req.params.accountId);
  res.json(rows);
});

router.post('/', (req, res) => {
  const { account_id, text, source, due_date, owner } = req.body;
  if (!account_id || !text) return res.status(400).json({ error: 'account_id and text required' });
  const id = uuid();
  const opportunityId = opportunities.resolveId(db, account_id, req.body.opportunity_id);
  db.prepare(`
    INSERT INTO next_steps (id, account_id, opportunity_id, text, source, completed, due_date, owner)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, account_id, opportunityId, text, source || 'manual', due_date || null, normalizeOwner(owner));
  res.status(201).json(db.prepare('SELECT * FROM next_steps WHERE id = ?').get(id));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM next_steps WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Next step not found' });
  const fields = ['text', 'completed', 'source', 'due_date', 'resolved_reason', 'resolved_note', 'owner'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in req.body) {
      updates.push(`${f} = ?`);
      if (f === 'completed') values.push(req.body[f] ? 1 : 0);
      else if (f === 'owner') values.push(normalizeOwner(req.body[f]));
      else values.push(req.body[f]);
    }
  }
  // Re-opening a step by hand clears the machine's explanation for closing it,
  // so a reinstated step doesn't still claim it was done or merged.
  if ('completed' in req.body && !req.body.completed && !('resolved_reason' in req.body)) {
    updates.push('resolved_reason = ?', 'resolved_note = ?');
    values.push(null, null);
  }
  if (!updates.length) return res.json(existing);
  values.push(req.params.id);
  db.prepare(`UPDATE next_steps SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM next_steps WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM next_steps WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
