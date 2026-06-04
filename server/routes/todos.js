const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');

const router = express.Router();

router.get('/:accountId', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM todos WHERE account_id = ? ORDER BY completed, created_at
  `).all(req.params.accountId);
  res.json(rows);
});

router.post('/', (req, res) => {
  const { account_id, text } = req.body;
  if (!account_id || !text) return res.status(400).json({ error: 'account_id and text required' });
  const id = uuid();
  db.prepare(`INSERT INTO todos (id, account_id, text, completed) VALUES (?, ?, ?, 0)`)
    .run(id, account_id, text);
  res.status(201).json(db.prepare('SELECT * FROM todos WHERE id = ?').get(id));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Todo not found' });
  const fields = ['text', 'completed'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in req.body) {
      updates.push(`${f} = ?`);
      values.push(f === 'completed' ? (req.body[f] ? 1 : 0) : req.body[f]);
    }
  }
  if (!updates.length) return res.json(existing);
  values.push(req.params.id);
  db.prepare(`UPDATE todos SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM todos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
