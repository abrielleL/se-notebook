const express = require('express');
const db = require('../db/database');

const router = express.Router();

function escapeFts(q) {
  // Wrap each whitespace-separated token in double quotes to defang FTS
  // operators, then append `*` so each token is a prefix query — this powers
  // type-ahead in the global search bar (e.g. "metad" matches "MetaDefender").
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"*`)
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
        a.account_name,
        -- Which deal the hit belongs to, resolved at query time rather than
        -- stored: adding a column to an FTS5 table means rebuilding it and all
        -- eighteen triggers, and at fifty rows these joins cost nothing.
        COALESCE(n.opportunity_id, t.opportunity_id, di.opportunity_id) AS opportunity_id
      FROM search_index si
      LEFT JOIN accounts a ON a.id = si.account_id
      LEFT JOIN notes n ON si.source_type = 'note' AND n.id = si.source_id
      LEFT JOIN transcripts t ON si.source_type = 'transcript' AND t.id = si.source_id
      LEFT JOIN deal_intelligence di ON si.source_type = 'deal' AND di.id = si.source_id
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
