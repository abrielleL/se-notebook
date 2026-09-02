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

// Partners don't move through the presales stages -- we sell *through* them, so
// there's no POV to run against a reseller. The field is hidden for partners in
// the UI and cleared here, so a stage can't linger out of sight and reappear
// (or skew stage stats) if the account is later switched back to a customer.
const stageAppliesTo = (type) => type !== 'partner';

// --- Snooze ---------------------------------------------------------------
// Whether an account is snoozed *right now*. Computed rather than stored so a
// dated snooze expires on its own with no cron job: the row keeps its values,
// and the account simply stops being snoozed once the date passes.
//
// Dates are compared as YYYY-MM-DD strings in local time, matching how
// close_date and note dates are already handled in this codebase.
const localToday = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function isSnoozed(account) {
  if (!account?.snoozed_at) return false;
  if (!account.snoozed_until) return true;          // indefinite
  return account.snoozed_until >= localToday();     // expires the day after
}

// Snooze windows offered by the UI. null = indefinite.
const SNOOZE_DAYS = [30, 60, 90];

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Partner links, both directions. account_id is always the customer side.
const partnersFor = (accountId) => db.prepare(`
  SELECT a.id, a.account_name, a.account_type
  FROM account_partners ap JOIN accounts a ON a.id = ap.partner_id
  WHERE ap.account_id = ? ORDER BY a.account_name
`).all(accountId);

const linkedAccountsFor = (partnerId) => db.prepare(`
  SELECT a.id, a.account_name, a.account_type, a.presales_stage
  FROM account_partners ap JOIN accounts a ON a.id = ap.account_id
  WHERE ap.partner_id = ? ORDER BY a.account_name
`).all(partnerId);

// Replace every link on one side of the relation in a single transaction.
// `side` is the column holding the id we're anchored to.
function replaceLinks(side, anchorId, otherIds) {
  const other = side === 'account_id' ? 'partner_id' : 'account_id';
  const del = db.prepare(`DELETE FROM account_partners WHERE ${side} = ?`);
  const ins = db.prepare(`INSERT OR IGNORE INTO account_partners (${side}, ${other}) VALUES (?, ?)`);
  db.transaction(() => {
    del.run(anchorId);
    for (const id of otherIds) ins.run(anchorId, id);
  })();
}

// tags is stored as a JSON-array TEXT column; expose it to clients as an array.
function withTags(account) {
  if (!account) return account;
  let tags = [];
  try { const a = JSON.parse(account.tags || '[]'); if (Array.isArray(a)) tags = a.filter(t => typeof t === 'string'); }
  catch { tags = []; }
  return {
    ...account,
    tags,
    account_type: normalizeAccountType(account.account_type),
    // Derived, so no client has to redo the date math (or disagree about it).
    is_snoozed: isSnoozed(account)
  };
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

  // Partner links for the whole list in one query rather than two per row --
  // the Accounts list and the Dashboard partner cards both need the names.
  const links = db.prepare(`
    SELECT ap.account_id, ap.partner_id, c.account_name AS account_name, p.account_name AS partner_name
    FROM account_partners ap
    JOIN accounts c ON c.id = ap.account_id
    JOIN accounts p ON p.id = ap.partner_id
  `).all();
  const partnersByAccount = new Map();
  const accountsByPartner = new Map();
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const l of links) {
    push(partnersByAccount, l.account_id, { id: l.partner_id, account_name: l.partner_name });
    push(accountsByPartner, l.partner_id, { id: l.account_id, account_name: l.account_name });
  }
  const byName = (a, b) => a.account_name.localeCompare(b.account_name);

  res.json(accounts.map(a => ({
    ...withTags(a),
    partners: (partnersByAccount.get(a.id) || []).sort(byName),
    linked_accounts: (accountsByPartner.get(a.id) || []).sort(byName)
  })));
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
  const type = normalizeAccountType(account_type);
  const stage = stageAppliesTo(type) ? (presales_stage || null) : null;

  db.prepare(`
    INSERT INTO accounts (id, account_name, account_executive, industry, opportunity_stage, presales_stage, color, risk, account_type, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, account_name, account_executive || null, industry || null, opportunity_stage || null, stage, color, initialRisk,
         type, tags.length ? JSON.stringify(tags) : null);

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  res.status(201).json(withTags(account));
});

router.get('/:id', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Via the join table, so partner contacts shared with other accounts appear
  // here too -- not just the ones whose primary account is this one.
  account.contacts = contactsForAccount(db, account.id);
  // Both directions, always: `partners` are the partners on this deal,
  // `linked_accounts` the deals this account works as a partner. Which one the
  // UI shows follows account_type, but a mistyped account still returns its
  // links so nothing is silently orphaned.
  account.partners = partnersFor(account.id);
  account.linked_accounts = linkedAccountsFor(account.id);
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

  // Switching to partner clears the stage; staying a partner ignores any stage
  // in the payload rather than writing one the UI won't show.
  const effType = normalizeAccountType('account_type' in req.body ? req.body.account_type : existing.account_type);
  const clearStage = !stageAppliesTo(effType);

  const updates = [];
  const values = [];
  for (const f of EDITABLE_FIELDS) {
    if (f === 'presales_stage' && clearStage) continue;
    if (f in req.body) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (clearStage && existing.presales_stage != null) {
    updates.push('presales_stage = ?');
    values.push(null);
  }
  // Moving an account's stage means it *is* moving, so it wakes up. Without
  // this you could advance a snoozed account and have it stay invisible on the
  // board -- the one place you'd look for it.
  if ('presales_stage' in req.body && !clearStage &&
      req.body.presales_stage && req.body.presales_stage !== existing.presales_stage &&
      isSnoozed(existing)) {
    updates.push('snoozed_at = ?', 'snoozed_until = ?', 'snooze_reason = ?');
    values.push(null, null, null);
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

// ---------------------------------------------------------------------------
// Snooze / unsnooze. The expiry date is computed server-side so every client
// agrees on what "90 days" means, and so a stale browser tab can't set a date
// in the past.
// ---------------------------------------------------------------------------

router.put('/:id/snooze', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // days omitted/null = snooze indefinitely; otherwise one of the offered windows.
  const raw = req.body?.days;
  const indefinite = raw == null || raw === '';
  const days = indefinite ? null : Number(raw);
  if (!indefinite && !SNOOZE_DAYS.includes(days)) {
    return res.status(400).json({ error: `days must be one of ${SNOOZE_DAYS.join(', ')} (or omitted for indefinite)` });
  }

  const reason = (req.body?.reason || '').trim() || null;
  db.prepare(
    'UPDATE accounts SET snoozed_at = CURRENT_TIMESTAMP, snoozed_until = ?, snooze_reason = ? WHERE id = ?'
  ).run(indefinite ? null : addDays(days), reason, account.id);

  res.json(withTags(db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id)));
});

router.delete('/:id/snooze', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  db.prepare(
    'UPDATE accounts SET snoozed_at = NULL, snoozed_until = NULL, snooze_reason = NULL WHERE id = ?'
  ).run(account.id);
  res.json(withTags(db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id)));
});

// ---------------------------------------------------------------------------
// Partner links. Both endpoints replace the full set for the account named in
// the path, which keeps the client simple: send the list you want, get the
// list back. Each validates the *other* side's type so a customer can't be
// linked in as a partner (or vice versa) and end up invisible on both pages.
// ---------------------------------------------------------------------------

// Resolve + type-check the ids on the far side of the link.
function resolveLinkIds(ids, expectedType, selfId) {
  if (!Array.isArray(ids)) return { error: 'Expected an array of account ids' };
  const unique = [...new Set(ids.filter(v => typeof v === 'string' && v))];
  if (unique.includes(selfId)) return { error: 'An account cannot be linked to itself' };
  if (!unique.length) return { ids: [] };

  const rows = db.prepare(
    `SELECT id, account_name, account_type FROM accounts WHERE id IN (${unique.map(() => '?').join(',')})`
  ).all(...unique);
  if (rows.length !== unique.length) return { error: 'One or more accounts no longer exist' };

  const wrong = rows.filter(r => normalizeAccountType(r.account_type) !== expectedType);
  if (wrong.length) {
    return { error: `Not ${expectedType === 'partner' ? 'a partner' : 'a customer'} account: ${wrong.map(r => r.account_name).join(', ')}` };
  }
  return { ids: unique };
}

// The partners working this account.
router.put('/:id/partners', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { ids, error } = resolveLinkIds(req.body?.partner_ids, 'partner', account.id);
  if (error) return res.status(400).json({ error });

  replaceLinks('account_id', account.id, ids);
  res.json({ partners: partnersFor(account.id) });
});

// The accounts this partner is working -- the same relation from the other end.
router.put('/:id/linked-accounts', (req, res) => {
  const partner = db.prepare('SELECT id, account_type FROM accounts WHERE id = ?').get(req.params.id);
  if (!partner) return res.status(404).json({ error: 'Account not found' });
  if (normalizeAccountType(partner.account_type) !== 'partner') {
    return res.status(400).json({ error: 'Only a partner account can be linked to accounts this way.' });
  }

  const { ids, error } = resolveLinkIds(req.body?.account_ids, 'customer', partner.id);
  if (error) return res.status(400).json({ error });

  replaceLinks('partner_id', partner.id, ids);
  res.json({ linked_accounts: linkedAccountsFor(partner.id) });
});

router.delete('/:id', (req, res) => {
  // foreign_keys is ON, so the partner links have to go first (from either
  // side) or the account delete fails on a constraint.
  db.transaction(() => {
    db.prepare('DELETE FROM account_partners WHERE account_id = ? OR partner_id = ?').run(req.params.id, req.params.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  })();
  res.json({ ok: true });
});

module.exports = router;
