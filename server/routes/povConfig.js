const express = require('express');
const db = require('../db/database');

const router = express.Router();

const CATEGORIES = ['product', 'deployment', 'os', 'use_case', 'integration', 'technology', 'file_type', 'compliance'];

function parseArr(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

function rowOut(r) {
  return {
    id: r.id,
    category: r.category,
    label: r.label,
    value: r.value,
    icon: r.icon,
    chroma_filter: r.chroma_filter,
    // Parsed arrays so the client never sees raw JSON strings. Falls back to the
    // legacy single chroma_filter slug if chroma_filters hasn't been migrated.
    chroma_filters: r.chroma_filters != null ? parseArr(r.chroma_filters) : (r.chroma_filter ? [r.chroma_filter] : []),
    valid_deployments: parseArr(r.valid_deployments),
    sort_order: r.sort_order
  };
}

// GET all active items grouped by category, ordered by sort_order ASC.
router.get('/pov-config', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM pov_config WHERE active = 1 ORDER BY category, sort_order ASC')
    .all();

  const grouped = {};
  for (const c of CATEGORIES) grouped[c] = [];
  for (const r of rows) {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(rowOut(r));
  }
  res.json(grouped);
});

// POST a new item. sort_order = MAX(sort_order)+1 for that category.
router.post('/pov-config', (req, res) => {
  console.log('[pov-config] POST body:', req.body);
  const { category, label, value, icon, chroma_filters, valid_deployments } = req.body || {};
  if (!category || !label || !value) {
    return res.status(400).json({ error: 'category, label and value required' });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Unknown category: ${category}` });
  }
  const max = db
    .prepare('SELECT MAX(sort_order) AS m FROM pov_config WHERE category = ?')
    .get(category).m;
  const sortOrder = (max == null ? -1 : max) + 1;

  const cf = Array.isArray(chroma_filters) && chroma_filters.length ? JSON.stringify(chroma_filters) : null;
  const vd = Array.isArray(valid_deployments) && valid_deployments.length ? JSON.stringify(valid_deployments) : null;
  const info = db.prepare(`
    INSERT INTO pov_config (category, label, value, icon, chroma_filters, valid_deployments, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(category, label, value, icon || 'ti-circle', cf, vd, sortOrder);

  const row = db.prepare('SELECT * FROM pov_config WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(rowOut(row));
});

// PUT update any subset of { label, value, icon, chroma_filter, sort_order, active }
router.put('/pov-config/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM pov_config WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item not found' });

  const allowed = ['label', 'value', 'icon', 'chroma_filter', 'sort_order', 'active'];
  const arrayFields = ['chroma_filters', 'valid_deployments']; // stored as JSON-array TEXT
  const updates = [];
  const values = [];
  for (const f of allowed) {
    if (f in req.body) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  for (const f of arrayFields) {
    if (f in req.body) {
      const v = req.body[f];
      updates.push(`${f} = ?`);
      values.push(Array.isArray(v) && v.length ? JSON.stringify(v) : null);
    }
  }
  if (!updates.length) return res.json(rowOut(existing));
  values.push(req.params.id);
  db.prepare(`UPDATE pov_config SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const row = db.prepare('SELECT * FROM pov_config WHERE id = ?').get(req.params.id);
  res.json(rowOut(row));
});

// DELETE — soft delete (active = 0).
router.delete('/pov-config/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM pov_config WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  db.prepare('UPDATE pov_config SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
