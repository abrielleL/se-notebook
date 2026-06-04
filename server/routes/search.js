const express = require('express');
const db = require('../db/database');

const router = express.Router();

function escapeFts(q) {
  // Wrap each whitespace-separated token in double quotes to defang FTS operators.
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const fts = escapeFts(q);
  try {
    const rows = db.prepare(`
      SELECT si.source_type, si.source_id, si.account_id, si.title,
        snippet(search_index, 4, '<mark>', '</mark>', '…', 16) AS snippet,
        a.account_name
      FROM search_index si
      LEFT JOIN accounts a ON a.id = si.account_id
      WHERE search_index MATCH ?
      ORDER BY rank
      LIMIT 50
    `).all(fts);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

module.exports = router;
