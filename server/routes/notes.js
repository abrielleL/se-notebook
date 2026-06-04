const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');

const router = express.Router();

router.get('/', (req, res) => {
  const { account_id, date_from, date_to } = req.query;
  const conds = ['deleted_at IS NULL'];
  const params = [];
  if (account_id) { conds.push('account_id = ?'); params.push(account_id); }
  if (date_from) { conds.push('date >= ?'); params.push(date_from); }
  if (date_to) { conds.push('date <= ?'); params.push(date_to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const notes = db.prepare(`
    SELECT n.*, a.account_name
    FROM notes n
    LEFT JOIN accounts a ON a.id = n.account_id
    ${where}
    ORDER BY date DESC, n.created_at DESC
  `).all(...params);
  res.json(notes);
});

router.get('/:id', (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  res.json(note);
});

router.post('/', (req, res) => {
  const { account_id, date, raw_notes, note_type, pending_ai_extraction } = req.body;
  if (!account_id || !date) return res.status(400).json({ error: 'account_id and date required' });
  const id = uuid();
  db.prepare(`
    INSERT INTO notes (id, account_id, date, raw_notes, note_type, pending_ai_extraction)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, account_id, date, raw_notes || '', note_type || null, pending_ai_extraction ? 1 : 0);
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  db.prepare(`
    INSERT INTO note_versions (id, note_id, snapshot)
    VALUES (?, ?, ?)
  `).run(uuid(), id, JSON.stringify(note));
  res.status(201).json(note);
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });

  db.prepare(`
    INSERT INTO note_versions (id, note_id, snapshot)
    VALUES (?, ?, ?)
  `).run(uuid(), existing.id, JSON.stringify(existing));

  const fields = ['date', 'raw_notes', 'note_type', 'pending_ai_extraction'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in req.body) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(req.params.id);
  db.prepare(`UPDATE notes SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  res.json(note);
});

router.delete('/:id', (req, res) => {
  db.prepare('UPDATE notes SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/restore', (req, res) => {
  db.prepare('UPDATE notes SET deleted_at = NULL WHERE id = ?').run(req.params.id);
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  res.json(note);
});

router.get('/:id/versions', (req, res) => {
  const versions = db.prepare(`
    SELECT * FROM note_versions WHERE note_id = ? ORDER BY created_at DESC
  `).all(req.params.id);
  res.json(versions);
});

module.exports = router;
