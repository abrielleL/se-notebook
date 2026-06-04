const express = require('express');
const db = require('../db/database');

const router = express.Router();

// GET all stored gate items for an account + stage, keyed by gate_key.
// The full list of gates per stage lives in the frontend config; this returns
// the persisted completion state which the frontend merges over that list.
router.get('/accounts/:id/stage-gates/:stage', (req, res) => {
  const rows = db
    .prepare('SELECT gate_key, completed, completed_at FROM stage_gate_progress WHERE account_id = ? AND stage = ?')
    .all(req.params.id, req.params.stage);

  const gates = {};
  for (const row of rows) {
    gates[row.gate_key] = { completed: !!row.completed, completed_at: row.completed_at };
  }
  res.json({ stage: req.params.stage, gates });
});

// PUT upsert completion for a single gate. Body: { completed: true|false }
router.put('/accounts/:id/stage-gates/:stage/:gate_key', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const completed = req.body && req.body.completed ? 1 : 0;
  const completedAt = completed ? new Date().toISOString() : null;

  db.prepare(`
    INSERT INTO stage_gate_progress (account_id, stage, gate_key, completed, completed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, stage, gate_key) DO UPDATE SET
      completed = excluded.completed,
      completed_at = excluded.completed_at
  `).run(req.params.id, req.params.stage, req.params.gate_key, completed, completedAt);

  const row = db
    .prepare('SELECT gate_key, completed, completed_at FROM stage_gate_progress WHERE account_id = ? AND stage = ? AND gate_key = ?')
    .get(req.params.id, req.params.stage, req.params.gate_key);
  res.json({ gate_key: row.gate_key, completed: !!row.completed, completed_at: row.completed_at });
});

module.exports = router;
