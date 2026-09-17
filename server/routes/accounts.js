const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const { PRESALES_STAGES } = require('../lib/stages');
const { contactsForAccount, promotePartnerContacts } = require('../lib/contactStore');
const opportunities = require('../lib/opportunityStore');
const { normalizeWebsiteUrl } = require('../lib/companyProfile');
const { resolveAeName } = require('../lib/aeRoster');

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
  'opportunity_value', 'ae_name', 'pov_success_plan_url', 'color', 'website_url'
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
  const aeName = resolveAeName(account_executive);
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
  `).run(id, account_name, aeName, industry || null, opportunity_stage || null, stage, color, initialRisk,
         type, tags.length ? JSON.stringify(tags) : null);

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  res.status(201).json(withTags(account));
});

router.get('/:id', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Without ?opportunity_id this returns everything the company has, which is
  // what the company view wants; with it, the page is one deal and sees only
  // that deal's content. An account that has never been split has exactly one
  // opportunity, so both answers are the same and its page is unchanged.
  account.opportunities = opportunities.listForAccount(db, account.id);
  const scopeId = req.query.opportunity_id
    ? opportunities.resolveId(db, account.id, req.query.opportunity_id)
    : null;
  account.opportunity_id = scopeId;

  // When the page is one deal, the account's deal fields are overlaid with
  // that deal's. The account row mirrors whichever opportunity is *live*, so
  // without this the stage bar, risk dot, close date and AI summary would all
  // keep showing the live deal while you were reading an archived one. Doing
  // it here rather than in the client means every existing `account.risk`
  // style reference in the UI is simply correct for whatever is selected.
  const scopeRow = scopeId
    ? db.prepare('SELECT * FROM opportunities WHERE id = ?').get(scopeId)
    : null;
  if (scopeRow) {
    for (const f of opportunities.DEAL_FIELDS) account[f] = scopeRow[f] ?? null;
    account.opportunity_name = scopeRow.name;
    account.opportunity_status = scopeRow.status;
    account.opportunity_archived_at = scopeRow.archived_at;
  }

  const scope = scopeId ? ' AND opportunity_id = ?' : '';
  const scoped = (...args) => (scopeId ? [...args, scopeId] : args);

  // Via the join table, so partner contacts shared with other accounts appear
  // here too -- not just the ones whose primary account is this one.
  account.contacts = contactsForAccount(db, account.id);
  // Both directions, always: `partners` are the partners on this deal,
  // `linked_accounts` the deals this account works as a partner. Which one the
  // UI shows follows account_type, but a mistyped account still returns its
  // links so nothing is silently orphaned.
  account.partners = partnersFor(account.id);
  account.linked_accounts = linkedAccountsFor(account.id);
  account.next_steps = db.prepare(`SELECT * FROM next_steps WHERE account_id = ?${scope} ORDER BY created_at`).all(...scoped(account.id));
  account.todos = db.prepare('SELECT * FROM todos WHERE account_id = ? ORDER BY created_at').all(account.id);
  account.notes = db.prepare(`
    SELECT * FROM notes
    WHERE account_id = ? AND deleted_at IS NULL${scope}
    ORDER BY date DESC, created_at DESC
  `).all(...scoped(account.id));
  account.transcripts = db.prepare(`SELECT * FROM transcripts WHERE account_id = ?${scope} ORDER BY call_date DESC, created_at DESC`).all(...scoped(account.id));
  account.attachments = db.prepare('SELECT * FROM attachments WHERE account_id = ? ORDER BY created_at DESC').all(account.id);
  account.meetings = db.prepare(`SELECT * FROM meetings WHERE account_id = ?${scope} ORDER BY start_time DESC`).all(...scoped(account.id));

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

  // The AE is usually typed as a first name. Expanded here rather than in the
  // form so every entry point gets it, and only when exactly one person on the
  // roster can be meant -- see lib/aeRoster.js. Both columns are handled:
  // ae_name is current, account_executive is where older rows keep it.
  for (const f of ['ae_name', 'account_executive']) {
    if (f in req.body) req.body[f] = resolveAeName(req.body[f]);
  }

  // A pasted website is normalized here (bare host -> https URL, tracking
  // params dropped) so the stored value is canonical no matter which entry
  // point wrote it.
  if ('website_url' in req.body) {
    const raw = (req.body.website_url || '').trim();
    if (!raw) {
      req.body.website_url = null;
    } else {
      const normalized = normalizeWebsiteUrl(raw);
      if (!normalized) {
        return res.status(400).json({ error: `That doesn't look like a website address: ${raw}` });
      }
      req.body.website_url = normalized;
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
  // company_profile is outside EDITABLE_FIELDS so that editing it by hand
  // clears company_profile_fetched_at. That timestamp means "read from the
  // website on this date" -- leaving it on hand-written text would label the
  // SE's own words as something the website said. Sites that block automated
  // fetches (and pages that need JavaScript to render) land here, so this is
  // a normal path, not a fallback.
  if ('company_profile' in req.body) {
    const profile = (req.body.company_profile || '').trim() || null;
    updates.push('company_profile = ?');
    values.push(profile);
    if (profile !== (existing.company_profile || null)) {
      updates.push('company_profile_fetched_at = ?');
      values.push(null);
    }
  }

  // status_note is handled outside EDITABLE_FIELDS so that a cleared note
  // normalizes to NULL rather than an empty string, and so its timestamp is
  // stamped from the server clock -- "updated 3 days ago" shouldn't depend on
  // whatever the browser thinks the time is. Re-saving identical text isn't an
  // update, so it doesn't bump the timestamp.
  if ('status_note' in req.body) {
    const note = (req.body.status_note || '').trim() || null;
    updates.push('status_note = ?');
    values.push(note);
    if (note !== (existing.status_note || null)) {
      updates.push('status_note_updated_at = ?');
      values.push(note ? new Date().toISOString() : null);
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
  // deal_outcome ('won' | 'lost' | 'dead', or null to reopen) is handled apart
  // from the columns above because the account's copy is a mirror: the write
  // lands on the opportunity's `status` and comes back via mirrorToAccount.
  // Setting one also snoozes the deal -- see setOutcome in lib/opportunityStore.
  let outcomeChange;
  if ('deal_outcome' in req.body) {
    const raw = (req.body.deal_outcome || '').trim();
    if (raw && !opportunities.OUTCOMES.includes(raw)) {
      return res.status(400).json({ error: `Invalid deal_outcome: ${raw}` });
    }
    outcomeChange = raw || null;
  }

  if (!updates.length && outcomeChange === undefined) return res.json(withTags(existing));
  values.push(req.params.id);

  // Deal fields (stage, risk, close date, value, the AI summary, snooze,
  // status note) now belong to an opportunity; the account's copies are a
  // mirror of whichever one is live. Rather than restructure every branch
  // above, the write still lands on the account first and is then pushed down
  // to the opportunity this edit was aimed at -- `opportunity_id` in the body,
  // or the account's default -- and mirrored back. Wrapped in a transaction so
  // the intermediate state, where the account briefly shows a non-primary
  // opportunity's values, is never visible to a reader.
  const touched = new Set(updates.map(u => u.split(' ')[0]));
  const dealFields = opportunities.DEAL_FIELDS.filter(f => touched.has(f));
  const targetOpportunityId = opportunities.resolveId(db, req.params.id, req.body.opportunity_id);

  db.transaction(() => {
    if (updates.length) {
      db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
    if (targetOpportunityId && dealFields.length) {
      const written = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
      db.prepare(`UPDATE opportunities SET ${dealFields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
        .run(...dealFields.map(f => written[f] ?? null), targetOpportunityId);
    }
    // After the deal fields, so that setting an outcome and its snooze in the
    // same request isn't overwritten by the account's older snooze values.
    if (outcomeChange !== undefined && targetOpportunityId) {
      opportunities.setOutcome(db, targetOpportunityId, outcomeChange);
    }
    if (targetOpportunityId && (dealFields.length || outcomeChange !== undefined)) {
      opportunities.mirrorToAccount(db, req.params.id);
    }
  })();
  // Switching an account to partner makes its contacts partner contacts. The
  // boot invariant would catch this eventually; doing it here means the
  // Contacts page is right immediately rather than after the next restart.
  if (effType === 'partner' && normalizeAccountType(existing.account_type) !== 'partner') {
    promotePartnerContacts(db, req.params.id);
  }
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
  // Snoozing hides a deal that isn't moving, not a company, so it is written
  // to the opportunity and mirrored back like every other deal field.
  const snoozeTarget = opportunities.resolveId(db, account.id, req.body?.opportunity_id);
  db.transaction(() => {
    db.prepare(`
      UPDATE opportunities SET snoozed_at = CURRENT_TIMESTAMP, snoozed_until = ?, snooze_reason = ?
      WHERE id = ?
    `).run(indefinite ? null : addDays(days), reason, snoozeTarget);
    opportunities.mirrorToAccount(db, account.id);
  })();

  res.json(withTags(db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id)));
});

router.delete('/:id/snooze', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const wakeTarget = opportunities.resolveId(db, account.id, req.body?.opportunity_id);
  db.transaction(() => {
    db.prepare(`
      UPDATE opportunities SET snoozed_at = NULL, snoozed_until = NULL, snooze_reason = NULL
      WHERE id = ?
    `).run(wakeTarget);
    opportunities.mirrorToAccount(db, account.id);
  })();
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
