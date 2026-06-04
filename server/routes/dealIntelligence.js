const express = require('express');
const db = require('../db/database');

const router = express.Router();

// The 8 qualification fields. Driven internally by a sales qualification
// framework; never surfaced under that name in the UI.
const FIELDS = [
  'success_metrics',
  'decision_maker',
  'evaluation_criteria',
  'buying_process',
  'paper_process',
  'business_pain',
  'internal_champion',
  'competitive_landscape'
];

function stamp(date = new Date()) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Upsert a deal-intelligence field. On conflict (same account_id + field),
// append the new content with a date stamp rather than overwrite:
//   "[Existing content]\n\n[Jun 8, 2026] [New extracted content]"
// Shared so the AI extraction pipeline can reuse the exact same behavior.
function upsertDealIntelligence(accountId, field, value, sourceNoteId = null) {
  const incoming = String(value == null ? '' : value).trim();
  if (!incoming) return null;

  const existing = db
    .prepare('SELECT value FROM deal_intelligence WHERE account_id = ? AND field = ?')
    .get(accountId, field);

  let newValue;
  if (existing && existing.value && existing.value.trim()) {
    newValue = `${existing.value}\n\n[${stamp()}] ${incoming}`;
  } else {
    newValue = incoming;
  }

  db.prepare(`
    INSERT INTO deal_intelligence (account_id, field, value, source_note_id, last_updated)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(account_id, field) DO UPDATE SET
      value = excluded.value,
      source_note_id = excluded.source_note_id,
      last_updated = CURRENT_TIMESTAMP
  `).run(accountId, field, newValue, sourceNoteId || null);

  return db
    .prepare('SELECT * FROM deal_intelligence WHERE account_id = ? AND field = ?')
    .get(accountId, field);
}

// GET all 8 fields as an object keyed by field name. Missing fields => ''.
router.get('/accounts/:id/deal-intelligence', (req, res) => {
  const rows = db
    .prepare('SELECT field, value, last_updated, source_note_id FROM deal_intelligence WHERE account_id = ?')
    .all(req.params.id);
  const byField = {};
  for (const row of rows) byField[row.field] = row;

  const out = {};
  for (const field of FIELDS) {
    out[field] = byField[field]
      ? { value: byField[field].value, last_updated: byField[field].last_updated, source_note_id: byField[field].source_note_id }
      : { value: '', last_updated: null, source_note_id: null };
  }
  res.json(out);
});

// PUT upsert a single field. Body: { value, source_note_id? }
router.put('/accounts/:id/deal-intelligence/:field', (req, res) => {
  const { field } = req.params;
  if (!FIELDS.includes(field)) {
    return res.status(400).json({ error: `Unknown field: ${field}` });
  }
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const value = req.body && req.body.value;
  if (value == null) {
    return res.status(400).json({ error: 'value required' });
  }

  // mode:'replace' overwrites the field outright (used by manual edits in the
  // expand drawer). Default behavior appends with a date stamp (used by AI).
  if (req.body.mode === 'replace') {
    db.prepare(`
      INSERT INTO deal_intelligence (account_id, field, value, source_note_id, last_updated)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(account_id, field) DO UPDATE SET
        value = excluded.value, last_updated = CURRENT_TIMESTAMP
    `).run(req.params.id, field, String(value), req.body.source_note_id || null);
    return res.json(db.prepare('SELECT * FROM deal_intelligence WHERE account_id = ? AND field = ?').get(req.params.id, field));
  }

  if (!String(value).trim()) return res.status(400).json({ error: 'value required' });
  const entry = upsertDealIntelligence(req.params.id, field, value, req.body.source_note_id);
  res.json(entry);
});

module.exports = router;
module.exports.upsertDealIntelligence = upsertDealIntelligence;
module.exports.DEAL_INTELLIGENCE_FIELDS = FIELDS;
