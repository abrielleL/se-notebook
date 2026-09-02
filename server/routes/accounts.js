const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const { PRESALES_STAGES } = require('../lib/stages');
const { contactsForAccount } = require('../lib/contactStore');

const router = express.Router();

// Identity colors for account cards / POV timeline bars, cycled on creation.
//
// Brand hues (product-UI chart-1..6), re-stepped for the dark app surfaces:
// the kit's light-mode chart values fail four of the six dataviz checks against
// #081938. Verified with the dataviz validator on that surface — worst adjacent
// CVD deltaE 18.8, normal-vision floor 32.3, every slot >= 3:1 contrast.
// Status colors are deliberately NOT in this list: red/amber/green mean risk
// elsewhere in the app and must not double as decoration.
const ACCOUNT_COLORS = ['#008a00', '#1d6bfc', '#e06106', '#8f47e8', '#e51a16', '#0f8fa3'];

// Fields accepted on PUT (existing + new). `tags` is handled separately (JSON).
const EDITABLE_FIELDS = [
  'account_name', 'account_executive', 'industry', 'opportunity_stage',
  'ai_summary', 'ai_technical_drivers', 'ai_environment', 'ai_summary_updated_at',
  'risk', 'presales_stage', 'escalation', 'jira_ticket_url', 'close_date',
  'opportunity_value', 'ae_name', 'pov_success_plan_url', 'color'
];

// account_type: 'customer' | 'partner'. Anything else (including the NULL that
// a row written before the migration could carry) reads as a customer.
const ACCOUNT_TYPES = ['customer', 'partner'];
const DEFAULT_ACCOUNT_TYPE = 'customer';
const normalizeAccountType = (v) => (ACCOUNT_TYPES.includes(v) ? v : DEFAULT_ACCOUNT_TYPE);

// tags is stored as a JSON-array TEXT column; expose it to clients as an array.
function withTags(account) {
  if (!account) return account;
  let tags = [];
  try { const a = JSON.parse(account.tags || '[]'); if (Array.isArray(a)) tags = a.filter(t => typeof t === 'string'); }
  catch { tags = []; }
  return { ...account, tags, account_type: normalizeAccountType(account.account_type) };
}
// Keep only labels that exist in the managed catalog, de-duped, preserving order.
function sanitizeTags(input) {
  if (!Array.isArray(input)) return [];
  const valid = new Set(db.prepare('SELECT label FROM tag_catalog').all().map(r => r.label));
  const seen = new Set();
  return input.filter(t => typeof t === 'string' && valid.has(t) && !seen.has(t) && seen.add(t));
}

router.get('/', (_req, res) => {
  const accounts = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM notes n WHERE n.account_id = a.id AND n.deleted_at IS NULL) AS note_count,
      (SELECT COUNT(*) FROM attachments at WHERE at.account_id = a.id) AS attachment_count,
      (SELECT COUNT(*) FROM transcripts t WHERE t.account_id = a.id) AS transcript_count,
      (SELECT MAX(n.created_at) FROM notes n WHERE n.account_id = a.id AND n.deleted_at IS NULL) AS last_note_date,
      (SELECT CAST((julianday('now') - julianday(MAX(n.created_at))) AS INTEGER)
         FROM notes n WHERE n.account_id = a.id AND n.deleted_at IS NULL) AS last_note_days_ago
    FROM accounts a
    ORDER BY a.created_at DESC
  `).all();
  res.json(accounts.map(withTags));
});

// Risk is the only account color surfaced in the UI (the dot on each dashboard
// card). New accounts start green -- "evaluation progressing, no detectable
// risk" is the right resting state -- and stay that way until someone changes
// it. The edit dropdown still offers a blank option, so clearing it remains a
// deliberate choice rather than something a new account falls into.
const RISK_VALUES = ['green', 'yellow', 'red'];
const DEFAULT_RISK = 'green';

router.post('/', (req, res) => {
  const { account_name, account_executive, industry, opportunity_stage, presales_stage, risk, account_type } = req.body;
  if (!account_name) return res.status(400).json({ error: 'account_name required' });
  if (presales_stage && !PRESALES_STAGES.includes(presales_stage)) {
    return res.status(400).json({ error: `Invalid presales_stage: ${presales_stage}` });
  }
  if (account_type && !ACCOUNT_TYPES.includes(account_type)) {
    return res.status(400).json({ error: `Invalid account_type: ${account_type}` });
  }

  const id = uuid();
  const count = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  const color = ACCOUNT_COLORS[count % ACCOUNT_COLORS.length];

  // An explicit risk in the payload wins; anything else falls back to green.
  const initialRisk = RISK_VALUES.includes(risk) ? risk : DEFAULT_RISK;

  // Tags may be set at creation time (the New Note form offers them alongside
  // the account type), so they don't need a follow-up PUT.
  const tags = sanitizeTags(req.body.tags);

  db.prepare(`
    INSERT INTO accounts (id, account_name, account_executive, industry, opportunity_stage, presales_stage, color, risk, account_type, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, account_name, account_executive || null, industry || null, opportunity_stage || null, presales_stage || null, color, initialRisk,
         normalizeAccountType(account_type), tags.length ? JSON.stringify(tags) : null);

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  res.status(201).json(withTags(account));
});

router.get('/:id', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Via the join table, so partner contacts shared with other accounts appear
  // here too -- not just the ones whose primary account is this one.
  account.contacts = contactsForAccount(db, account.id);
  account.next_steps = db.prepare('SELECT * FROM next_steps WHERE account_id = ? ORDER BY created_at').all(account.id);
  account.todos = db.prepare('SELECT * FROM todos WHERE account_id = ? ORDER BY created_at').all(account.id);
  account.notes = db.prepare(`
    SELECT * FROM notes
    WHERE account_id = ? AND deleted_at IS NULL
    ORDER BY date DESC, created_at DESC
  `).all(account.id);
  account.transcripts = db.prepare('SELECT * FROM transcripts WHERE account_id = ? ORDER BY call_date DESC, created_at DESC').all(account.id);
  account.attachments = db.prepare('SELECT * FROM attachments WHERE account_id = ? ORDER BY created_at DESC').all(account.id);
  account.meetings = db.prepare('SELECT * FROM meetings WHERE account_id = ? ORDER BY start_time DESC').all(account.id);

  const agg = db.prepare(`
    SELECT MAX(created_at) AS last_note_date,
           CAST((julianday('now') - julianday(MAX(created_at))) AS INTEGER) AS last_note_days_ago
    FROM notes WHERE account_id = ? AND deleted_at IS NULL
  `).get(account.id);
  account.last_note_date = agg.last_note_date || null;
  account.last_note_days_ago = agg.last_note_date ? agg.last_note_days_ago : null;

  res.json(withTags(account));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Account not found' });

  // Validate presales_stage against the canonical list (null/'' allowed).
  if ('presales_stage' in req.body) {
    const ps = req.body.presales_stage;
    if (ps && !PRESALES_STAGES.includes(ps)) {
      return res.status(400).json({ error: `Invalid presales_stage: ${ps}` });
    }
  }

  if ('account_type' in req.body) {
    const at = req.body.account_type;
    if (at && !ACCOUNT_TYPES.includes(at)) {
      return res.status(400).json({ error: `Invalid account_type: ${at}` });
    }
  }

  // Validate escalation <-> Jira ticket requirement against the resulting state.
  const effEscalation = ('escalation' in req.body) ? req.body.escalation : existing.escalation;
  const effJira = ('jira_ticket_url' in req.body) ? req.body.jira_ticket_url : existing.jira_ticket_url;
  if ((effEscalation === 'Tech Blocked' || effEscalation === 'Tech Challenged') &&
      (!effJira || !String(effJira).trim())) {
    return res.status(400).json({
      error: 'Jira ticket URL required when escalation is Tech Blocked or Tech Challenged.'
    });
  }

  const updates = [];
  const values = [];
  for (const f of EDITABLE_FIELDS) {
    if (f in req.body) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  // account_type is kept out of EDITABLE_FIELDS so an empty/unknown value
  // normalizes to 'customer' rather than writing a NULL the tabs can't read.
  if ('account_type' in req.body) {
    updates.push('account_type = ?');
    values.push(normalizeAccountType(req.body.account_type));
  }
  // tags: validate against the managed catalog, store as JSON (or NULL if empty).
  if ('tags' in req.body) {
    const tags = sanitizeTags(req.body.tags);
    updates.push('tags = ?');
    values.push(tags.length ? JSON.stringify(tags) : null);
  }
  if (!updates.length) return res.json(withTags(existing));
  values.push(req.params.id);
  db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  res.json(withTags(account));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
