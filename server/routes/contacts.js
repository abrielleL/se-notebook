const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const {
  CONTACT_TYPES, CONTACT_ROLES, cleanType, cleanRole,
  upsertContact, linkAccount, hydrate, mergeContacts
} = require('../lib/contactStore');
const { syncPrimaryAccount } = require('../db/contactsMigration');

const router = express.Router();

// ---------------------------------------------------------------------------
// Directory
//
// GET /api/contacts?q=&type=&role=&account_id=&sort=
//
// One row per person (not per account link), with their accounts aggregated so
// the directory can show "Ron Howell — Guidepoint — 5 accounts" without an
// N+1. `last_touched` is the most recent contact note, used for sorting.
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const { q, type, role, account_id, sort } = req.query;

  const where = [];
  const params = [];

  if (q && String(q).trim()) {
    const like = `%${String(q).trim().toLowerCase()}%`;
    where.push(`(LOWER(c.name) LIKE ? OR LOWER(COALESCE(c.title,'')) LIKE ?
                 OR LOWER(COALESCE(c.email,'')) LIKE ? OR LOWER(COALESCE(c.org_name,'')) LIKE ?)`);
    params.push(like, like, like, like);
  }
  if (type && CONTACT_TYPES.includes(type)) {
    where.push('c.contact_type = ?');
    params.push(type);
  }
  if (account_id) {
    where.push('EXISTS (SELECT 1 FROM contact_accounts x WHERE x.contact_id = c.id AND x.account_id = ?)');
    params.push(account_id);
  }
  if (role && CONTACT_ROLES.includes(role)) {
    where.push('EXISTS (SELECT 1 FROM contact_accounts x WHERE x.contact_id = c.id AND x.role = ?)');
    params.push(role);
  }

  const orderBy = {
    name: 'c.name COLLATE NOCASE ASC',
    org: "COALESCE(NULLIF(c.org_name,''), 'zzz') COLLATE NOCASE ASC, c.name COLLATE NOCASE ASC",
    accounts: 'account_count DESC, c.name COLLATE NOCASE ASC',
    recent: 'COALESCE(last_touched, c.created_at) DESC',
    created: 'c.created_at DESC'
  }[sort] || 'c.name COLLATE NOCASE ASC';

  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM contact_accounts ca WHERE ca.contact_id = c.id) AS account_count,
      (SELECT COUNT(*) FROM contact_notes cn WHERE cn.contact_id = c.id) AS note_count,
      (SELECT MAX(cn.created_at) FROM contact_notes cn WHERE cn.contact_id = c.id) AS last_touched,
      (SELECT GROUP_CONCAT(a.account_name, ' | ')
         FROM contact_accounts ca JOIN accounts a ON a.id = ca.account_id
         WHERE ca.contact_id = c.id) AS account_names,
      (SELECT GROUP_CONCAT(ca.account_id, ',')
         FROM contact_accounts ca WHERE ca.contact_id = c.id) AS account_ids,
      (SELECT GROUP_CONCAT(COALESCE(ca.role,''), ',')
         FROM contact_accounts ca WHERE ca.contact_id = c.id) AS roles
    FROM contacts c
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}
  `).all(...params);

  res.json(rows.map(r => ({
    ...r,
    account_names: r.account_names ? r.account_names.split(' | ') : [],
    account_ids: r.account_ids ? r.account_ids.split(',') : [],
    roles: r.roles ? r.roles.split(',').filter(Boolean) : []
  })));
});

// Aggregate counts for the directory header chips.
router.get('/stats', (_req, res) => {
  const byType = db.prepare(
    'SELECT COALESCE(contact_type, \'customer\') AS type, COUNT(*) AS n FROM contacts GROUP BY type'
  ).all();
  const total = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  const pendingDupes = db.prepare(
    "SELECT COUNT(*) AS n FROM contact_merge_candidates WHERE status = 'pending'"
  ).get().n;
  const multiAccount = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT contact_id FROM contact_accounts GROUP BY contact_id HAVING COUNT(*) > 1
    )
  `).get().n;
  res.json({ total, by_type: byType, pending_duplicates: pendingDupes, multi_account: multiAccount });
});

// ---------------------------------------------------------------------------
// Duplicate review queue
// Declared before /:id so "merge-candidates" isn't captured as an id.
// ---------------------------------------------------------------------------
router.get('/merge-candidates', (_req, res) => {
  const rows = db.prepare(`
    SELECT m.*, a.account_name
    FROM contact_merge_candidates m
    LEFT JOIN accounts a ON a.id = m.account_id
    WHERE m.status = 'pending'
    ORDER BY m.score DESC, m.created_at ASC
  `).all();

  const get = db.prepare('SELECT * FROM contacts WHERE id = ?');
  const linkCount = db.prepare('SELECT COUNT(*) AS n FROM contact_accounts WHERE contact_id = ?');
  const noteCount = db.prepare('SELECT COUNT(*) AS n FROM contact_notes WHERE contact_id = ?');

  const decorate = (id) => {
    const c = get.get(id);
    if (!c) return null;
    return { ...c, account_count: linkCount.get(id).n, note_count: noteCount.get(id).n };
  };

  res.json(rows.map(r => ({
    id: r.id,
    reason: r.reason,
    score: r.score,
    account_id: r.account_id,
    account_name: r.account_name,
    a: decorate(r.contact_id_a),
    b: decorate(r.contact_id_b)
  })).filter(r => r.a && r.b));
});

router.post('/merge-candidates/:id/dismiss', (req, res) => {
  const row = db.prepare('SELECT * FROM contact_merge_candidates WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Candidate not found' });
  db.prepare("UPDATE contact_merge_candidates SET status = 'dismissed' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Merge two contacts. keeper_id survives; loser_id's links, notes and any
// fields the keeper lacks move across before it is deleted.
router.post('/merge', (req, res) => {
  const { keeper_id, loser_id } = req.body || {};
  if (!keeper_id || !loser_id) return res.status(400).json({ error: 'keeper_id and loser_id required' });
  if (keeper_id === loser_id) return res.status(400).json({ error: 'Cannot merge a contact into itself' });

  const keeper = db.prepare('SELECT * FROM contacts WHERE id = ?').get(keeper_id);
  const loser = db.prepare('SELECT * FROM contacts WHERE id = ?').get(loser_id);
  if (!keeper || !loser) return res.status(404).json({ error: 'Contact not found' });

  const result = mergeContacts(db, keeper_id, loser_id);
  if (!result) return res.status(500).json({ error: 'Merge failed' });
  res.json(hydrate(db, result));
});

// ---------------------------------------------------------------------------
// Single contact
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contact not found' });
  res.json(hydrate(db, c));
});

// Create. account_id is optional -- a contact can exist in the directory before
// being tied to a deal. Goes through the shared upsert, so adding a name that
// already exists on the account enriches it instead of duplicating.
router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name required' });

  if (b.account_id) {
    const acct = db.prepare('SELECT id FROM accounts WHERE id = ?').get(b.account_id);
    if (!acct) return res.status(400).json({ error: 'Unknown account_id' });
  }

  const result = upsertContact(db, {
    account_id: b.account_id || null,
    name: b.name,
    title: b.title,
    email: b.email,
    phone: b.phone,
    org_name: b.org_name,
    contact_type: b.contact_type,
    role: b.meddpicc_role || b.role,
    auto_extracted: 0
  });

  if (!result) return res.status(400).json({ error: 'Name could not be parsed' });
  if (!result.contact) return res.status(400).json({ error: 'Contact was skipped', reason: result.reason });

  res.status(result.created ? 201 : 200).json({
    ...hydrate(db, result.contact),
    _merged_into_existing: !result.created
  });
});

const EDITABLE = ['name', 'title', 'email', 'phone', 'org_name', 'contact_type', 'meddpicc_role'];

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });

  const { normalizeName, nameKey } = require('../lib/contactNames');
  const updates = [];
  const values = [];

  for (const f of EDITABLE) {
    if (!(f in req.body)) continue;
    let v = req.body[f];
    if (f === 'name') {
      const norm = normalizeName(v);
      if (!norm) return res.status(400).json({ error: 'Name could not be parsed' });
      const key = nameKey(norm);
      // Renaming onto an existing contact on the same account would violate the
      // unique index; tell the user to merge instead of failing opaquely.
      const clash = db.prepare(
        'SELECT id, name FROM contacts WHERE account_id = ? AND name_key = ? AND id != ?'
      ).get(existing.account_id, key, existing.id);
      if (clash) {
        return res.status(409).json({
          error: `"${clash.name}" already exists on this account. Merge them instead.`,
          conflict_contact_id: clash.id
        });
      }
      updates.push('name = ?', 'name_key = ?');
      values.push(norm, key);
      continue;
    }
    if (f === 'contact_type') v = cleanType(v);
    if (f === 'meddpicc_role') v = cleanRole(v);
    updates.push(`${f} = ?`);
    values.push(v === '' ? null : v);
  }

  if (updates.length) {
    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(req.params.id);
    db.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
  res.json(hydrate(db, db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM contact_merge_candidates WHERE contact_id_a = ? OR contact_id_b = ?')
    .run(req.params.id, req.params.id);
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Account links -- the partner case. One contact, many accounts, a role per
// account.
// ---------------------------------------------------------------------------
router.post('/:id/accounts', (req, res) => {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contact not found' });

  const { account_id, role, is_primary } = req.body || {};
  if (!account_id) return res.status(400).json({ error: 'account_id required' });
  const acct = db.prepare('SELECT id FROM accounts WHERE id = ?').get(account_id);
  if (!acct) return res.status(400).json({ error: 'Unknown account_id' });

  linkAccount(db, req.params.id, account_id, cleanRole(role), Boolean(is_primary));
  res.status(201).json(hydrate(db, db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id)));
});

router.put('/:id/accounts/:accountId', (req, res) => {
  const link = db.prepare(
    'SELECT * FROM contact_accounts WHERE contact_id = ? AND account_id = ?'
  ).get(req.params.id, req.params.accountId);
  if (!link) return res.status(404).json({ error: 'Link not found' });

  if ('role' in req.body) {
    db.prepare('UPDATE contact_accounts SET role = ? WHERE id = ?')
      .run(cleanRole(req.body.role), link.id);
  }
  if (req.body.is_primary) {
    db.prepare('UPDATE contact_accounts SET is_primary = 0 WHERE contact_id = ?').run(req.params.id);
    db.prepare('UPDATE contact_accounts SET is_primary = 1 WHERE id = ?').run(link.id);
    syncPrimaryAccount(db, req.params.id);
  }
  res.json(hydrate(db, db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id)));
});

router.delete('/:id/accounts/:accountId', (req, res) => {
  db.prepare('DELETE FROM contact_accounts WHERE contact_id = ? AND account_id = ?')
    .run(req.params.id, req.params.accountId);
  // Re-point the primary account (and the FTS row) at a remaining link.
  syncPrimaryAccount(db, req.params.id);
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!c) return res.json({ ok: true, deleted: true });
  res.json(hydrate(db, c));
});

// ---------------------------------------------------------------------------
// Notes about a person
// ---------------------------------------------------------------------------
router.post('/:id/notes', (req, res) => {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contact not found' });

  const body = (req.body && req.body.body ? String(req.body.body) : '').trim();
  if (!body) return res.status(400).json({ error: 'body required' });

  const accountId = req.body.account_id || null;
  if (accountId && !db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId)) {
    return res.status(400).json({ error: 'Unknown account_id' });
  }

  const id = uuid();
  db.prepare('INSERT INTO contact_notes (id, contact_id, account_id, body) VALUES (?, ?, ?, ?)')
    .run(id, req.params.id, accountId, body);
  res.status(201).json(db.prepare('SELECT * FROM contact_notes WHERE id = ?').get(id));
});

router.put('/:id/notes/:noteId', (req, res) => {
  const note = db.prepare('SELECT * FROM contact_notes WHERE id = ? AND contact_id = ?')
    .get(req.params.noteId, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  const updates = [];
  const values = [];
  if ('body' in req.body) {
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'body cannot be empty' });
    updates.push('body = ?');
    values.push(body);
  }
  if ('account_id' in req.body) {
    updates.push('account_id = ?');
    values.push(req.body.account_id || null);
  }
  if (updates.length) {
    updates.push('updated_at = ?');
    values.push(new Date().toISOString(), req.params.noteId);
    db.prepare(`UPDATE contact_notes SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
  res.json(db.prepare('SELECT * FROM contact_notes WHERE id = ?').get(req.params.noteId));
});

router.delete('/:id/notes/:noteId', (req, res) => {
  db.prepare('DELETE FROM contact_notes WHERE id = ? AND contact_id = ?')
    .run(req.params.noteId, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
