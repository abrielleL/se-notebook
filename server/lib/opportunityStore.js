const { v4: uuid } = require('uuid');

// ---------------------------------------------------------------------------
// Opportunities — stage 2: the opportunity is now authoritative for the deal.
//
// The account row keeps its deal columns, but only as a *mirror* of the
// account's primary opportunity. That is what makes this change small: the
// dashboard, the stage board, the Accounts list, the FTS index and every
// export still read `accounts.presales_stage` and friends exactly as before,
// and keep working untouched, while the opportunity is the thing actually
// edited. The account's headline stage means "where the live deal is", which
// is what those screens wanted from it all along.
//
// The mirror is maintained here rather than by a SQL trigger so that there is
// one readable place to reason about direction of truth. Every write to a deal
// field is funnelled through `PUT /api/accounts/:id`, the snooze endpoints, or
// the opportunities routes, and all of them call `mirrorToAccount`.
// ---------------------------------------------------------------------------

// Columns that exist on both tables and flow opportunity -> account.
// account_name, industry, ae_name, account_executive, tags, color,
// account_type and ai_environment are deliberately absent: those describe the
// company and are edited on the account itself.
const DEAL_FIELDS = [
  'opportunity_stage', 'presales_stage', 'close_date', 'opportunity_value',
  'risk', 'escalation', 'jira_ticket_url', 'pov_success_plan_url',
  'status_note', 'status_note_updated_at',
  'snoozed_at', 'snoozed_until', 'snooze_reason',
  'ai_summary', 'ai_technical_drivers', 'ai_summary_updated_at'
];

// Fields a client may set directly on an opportunity.
const EDITABLE_FIELDS = DEAL_FIELDS.concat(['name', 'sugar_opportunity_id', 'sort_order']);

const STATUSES = ['active', 'won', 'lost'];

function listForAccount(db, accountId) {
  return db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM notes n
         WHERE n.opportunity_id = o.id AND n.deleted_at IS NULL) AS note_count,
      (SELECT COUNT(*) FROM transcripts t WHERE t.opportunity_id = o.id) AS transcript_count,
      (SELECT COUNT(*) FROM next_steps s
         WHERE s.opportunity_id = o.id AND s.completed = 0) AS open_step_count,
      (SELECT COUNT(*) FROM pov_drafts p WHERE p.opportunity_id = o.id) AS pov_count
    FROM opportunities o
    WHERE o.account_id = ?
    ORDER BY o.archived_at IS NOT NULL, o.sort_order, o.created_at
  `).all(accountId);
}

// The opportunity whose deal fields the account row mirrors: the first live
// one. An account whose deals are all closed still mirrors the most recently
// closed one rather than going blank — a won account should keep reading as
// won on the board until a new deal is opened.
function primaryFor(db, accountId) {
  return db.prepare(`
    SELECT * FROM opportunities WHERE account_id = ?
    ORDER BY archived_at IS NOT NULL, status <> 'active', sort_order,
             closed_at DESC, created_at
    LIMIT 1
  `).get(accountId);
}

// Where content lands when nothing says otherwise: the opportunity carried
// over from before the account was ever split.
function defaultFor(db, accountId) {
  return db.prepare(`
    SELECT * FROM opportunities WHERE account_id = ?
    ORDER BY is_default DESC, sort_order, created_at LIMIT 1
  `).get(accountId);
}

// Resolve a client-supplied opportunity_id, rejecting one that belongs to a
// different account rather than silently writing across the boundary. Falls
// back to the account's default opportunity so a caller that knows nothing
// about opportunities still writes somewhere sensible.
function resolveId(db, accountId, requested) {
  if (requested) {
    const row = db.prepare('SELECT id FROM opportunities WHERE id = ? AND account_id = ?')
      .get(requested, accountId);
    if (row) return row.id;
  }
  // The live deal rather than the original one: it is what the company view
  // is showing, so it is what an unscoped write should act on.
  const fallback = primaryFor(db, accountId);
  return fallback ? fallback.id : null;
}

// Find the account that owns an opportunity, for callers holding only an
// opportunity id.
function accountIdFor(db, opportunityId) {
  const row = db.prepare('SELECT account_id FROM opportunities WHERE id = ?').get(opportunityId);
  return row ? row.account_id : null;
}

function countFor(db, accountId) {
  return db.prepare('SELECT COUNT(*) AS n FROM opportunities WHERE account_id = ?').get(accountId).n;
}

// Copy the primary opportunity's deal fields down onto the account row. Called
// after every write that can change which opportunity is primary or what it
// holds. A no-op for an account with no opportunities, which should not happen
// (the accounts insert trigger guarantees one) but is not worth crashing over.
function mirrorToAccount(db, accountId) {
  const primary = primaryFor(db, accountId);
  if (!primary) return;
  db.prepare(`
    UPDATE accounts SET ${DEAL_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ?
  `).run(...DEAL_FIELDS.map(f => primary[f] ?? null), accountId);
}

// Create an opportunity. `seed` may carry any editable field; everything else
// starts empty, because a new deal at a known company inherits the company's
// context (contacts, environment, files) and nothing of the previous deal's
// state — that is the whole point of splitting them.
function create(db, accountId, seed = {}) {
  const id = uuid();
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS n FROM opportunities WHERE account_id = ?'
  ).get(accountId).n;

  const fields = ['id', 'account_id', 'name', 'sort_order', 'is_default'];
  const values = [id, accountId, seed.name || 'New opportunity', maxOrder + 1, 0];
  for (const f of DEAL_FIELDS.concat(['sugar_opportunity_id'])) {
    if (seed[f] !== undefined) { fields.push(f); values.push(seed[f]); }
  }
  db.prepare(
    `INSERT INTO opportunities (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`
  ).run(...values);
  return db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
}

module.exports = {
  DEAL_FIELDS, EDITABLE_FIELDS, STATUSES,
  listForAccount, primaryFor, defaultFor, resolveId, accountIdFor, countFor,
  mirrorToAccount, create
};
