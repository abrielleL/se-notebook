const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');

const router = express.Router();

router.post('/', (req, res) => {
  const { account_id, name, title, email, phone, meddpicc_role } = req.body;
  if (!account_id || !name) return res.status(400).json({ error: 'account_id and name required' });
  const id = uuid();
  db.prepare(`INSERT INTO contacts (id, account_id, name, title, email, phone, meddpicc_role) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, account_id, name, title || null, email || null, phone || null, meddpicc_role || null);
  res.status(201).json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });
  const fields = ['name', 'title', 'email', 'phone', 'meddpicc_role'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in req.body) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (!updates.length) return res.json(existing);
  values.push(req.params.id);
  db.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
