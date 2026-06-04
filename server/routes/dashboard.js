const express = require('express');
const db = require('../db/database');

const router = express.Router();

router.get('/', (_req, res) => {
  const recentNotes = db.prepare(`
    SELECT n.id, n.account_id, n.date, n.raw_notes, n.created_at,
           a.account_name, a.opportunity_stage
    FROM notes n
    LEFT JOIN accounts a ON a.id = n.account_id
    WHERE n.deleted_at IS NULL
    ORDER BY n.date DESC, n.created_at DESC
    LIMIT 10
  `).all();

  const openNextSteps = db.prepare(`
    SELECT ns.*, a.account_name
    FROM next_steps ns
    LEFT JOIN accounts a ON a.id = ns.account_id
    WHERE ns.completed = 0
    ORDER BY a.account_name, ns.created_at
  `).all();

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM accounts) AS account_count,
      (SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL) AS note_count
  `).get();

  res.json({ recentNotes, openNextSteps, totals });
});

module.exports = router;
