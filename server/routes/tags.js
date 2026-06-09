const express = require('express');
const db = require('../db/database');

const router = express.Router();

function rowOut(r) {
  return {
    id: r.id,
    label: r.label,
    color: r.color || '#58a6ff',
    is_inactive: !!r.is_inactive,
    sort_order: r.sort_order
  };
}

function parseTags(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a.filter(t => typeof t === 'string') : []; }
  catch { return []; }
}

// Apply a transform to every account's tags JSON, writing back only when changed.
// Used to keep accounts.tags consistent when a catalog tag is renamed or deleted.
const syncAccountTags = (fn) => {
  const rows = db.prepare('SELECT id, tags FROM accounts WHERE tags IS NOT NULL').all();
  const update = db.prepare('UPDATE accounts SET tags = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) {
      const before = parseTags(r.tags);
      const after = fn(before);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        update.run(after.length ? JSON.stringify(after) : null, r.id);
      }
    }
  });
  tx();
};

// GET catalog, ordered for display.
router.get('/tags', (_req, res) => {
  const rows = db.prepare('SELECT * FROM tag_catalog ORDER BY sort_order ASC, label ASC').all();
  res.json(rows.map(rowOut));
});

// POST a new tag. label is unique (case-insensitive guard).
router.post('/tags', (req, res) => {
  const label = (req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: 'label required' });
  const dupe = db.prepare('SELECT id FROM tag_catalog WHERE lower(label) = lower(?)').get(label);
  if (dupe) return res.status(409).json({ error: 'A tag with that label already exists.' });

  const color = (req.body?.color || '#58a6ff').trim();
  const isInactive = req.body?.is_inactive ? 1 : 0;
  const max = db.prepare('SELECT MAX(sort_order) AS m FROM tag_catalog').get().m;
  const sortOrder = (max == null ? -1 : max) + 1;
  const info = db.prepare(
    'INSERT INTO tag_catalog (label, color, is_inactive, sort_order) VALUES (?, ?, ?, ?)'
  ).run(label, color, isInactive, sortOrder);
  res.status(201).json(rowOut(db.prepare('SELECT * FROM tag_catalog WHERE id = ?').get(info.lastInsertRowid)));
});

// PUT update label/color/is_inactive/sort_order. Renaming the label rewrites it
// across every account that carries it so chips and search stay consistent.
router.put('/tags/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tag_catalog WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tag not found' });

  const updates = [];
  const values = [];
  let renameTo = null;
  if ('label' in req.body) {
    const label = (req.body.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label cannot be empty' });
    const dupe = db.prepare('SELECT id FROM tag_catalog WHERE lower(label) = lower(?) AND id != ?').get(label, existing.id);
    if (dupe) return res.status(409).json({ error: 'A tag with that label already exists.' });
    if (label !== existing.label) renameTo = label;
    updates.push('label = ?'); values.push(label);
  }
  if ('color' in req.body) { updates.push('color = ?'); values.push((req.body.color || '#58a6ff').trim()); }
  if ('is_inactive' in req.body) { updates.push('is_inactive = ?'); values.push(req.body.is_inactive ? 1 : 0); }
  if ('sort_order' in req.body) { updates.push('sort_order = ?'); values.push(Number(req.body.sort_order) || 0); }
  if (!updates.length) return res.json(rowOut(existing));

  values.push(existing.id);
  db.prepare(`UPDATE tag_catalog SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  if (renameTo) {
    syncAccountTags(tags => tags.map(t => (t === existing.label ? renameTo : t)));
  }
  res.json(rowOut(db.prepare('SELECT * FROM tag_catalog WHERE id = ?').get(existing.id)));
});

// DELETE a tag and strip it from every account that carries it.
router.delete('/tags/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tag_catalog WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tag not found' });
  db.prepare('DELETE FROM tag_catalog WHERE id = ?').run(existing.id);
  syncAccountTags(tags => tags.filter(t => t !== existing.label));
  res.json({ success: true });
});

module.exports = router;
