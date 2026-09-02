// ---------------------------------------------------------------------------
// The single write path for contacts.
//
// Both the manual "add contact" form and the AI extraction pipeline go through
// upsertContact() so they cannot disagree about what counts as a duplicate.
// The original bug was that extraction had its own ad-hoc `LOWER(name)` check;
// there is now exactly one implementation.
//
// Resolution order for an incoming name on an account:
//   1. Exact name_key match on this account         -> enrich the existing row.
//   2. Confident near-match (typo, token order)     -> enrich the existing row.
//   3. Ambiguous near-match (fragment, misspelling) -> insert, and queue the
//                                                      pair for human review.
//   4. Single-token name from extraction            -> fold into the account's
//      only contact with that first name, or skip entirely. Never creates a
//      bare "Paul" row alongside "Paul Lospinuso".
// ---------------------------------------------------------------------------

const { v4: uuid } = require('uuid');
const { normalizeName, nameKey, tokenCount, compareNames } = require('./contactNames');
const { normalizeLinkedInUrl } = require('./linkedin');
const { mergeContacts, syncPrimaryAccount } = require('../db/contactsMigration');

const CONTACT_TYPES = ['customer', 'partner', 'analyst', 'internal'];
const CONTACT_ROLES = ['decision_maker', 'champion', 'technical_lead', 'influencer', 'procurement'];

function cleanType(t) {
  return CONTACT_TYPES.includes(t) ? t : 'customer';
}

// Someone on a partner account works for the partner, so they read as a
// partner contact wherever they appear. 'customer' is the type everything
// defaults to when nobody said otherwise -- including the extraction pipeline
// and the add-contact forms -- so on a partner account it carries no
// information and is upgraded. An explicit 'analyst' or 'internal' is a real
// choice and is left alone.
//
// Exported because the same rule has to hold in three places: here (new
// contacts), the boot invariant (existing rows), and the accounts PUT (an
// account switched to partner after its contacts already existed).
function isPartnerAccount(db, accountId) {
  if (!accountId) return false;
  const row = db.prepare('SELECT account_type FROM accounts WHERE id = ?').get(accountId);
  return !!row && row.account_type === 'partner';
}

// The type a contact should carry given what the caller asked for and which
// account they're being filed under.
function resolveType(db, requestedType, accountId) {
  const clean = cleanType(requestedType);
  if (clean !== 'customer') return clean;                  // explicit analyst/internal/partner
  return isPartnerAccount(db, accountId) ? 'partner' : 'customer';
}

// Promote every default-typed contact linked to a partner account. Matches on
// contact_accounts (not contacts.account_id) so a contact whose primary
// account is elsewhere still counts if any of their accounts is a partner.
// Scope to one account by passing its id; omit it to sweep every partner.
function promotePartnerContacts(db, accountId = null) {
  return db.prepare(`
    UPDATE contacts SET contact_type = 'partner'
    WHERE COALESCE(contact_type, 'customer') = 'customer'
      AND EXISTS (
        SELECT 1 FROM contact_accounts ca
          JOIN accounts a ON a.id = ca.account_id
         WHERE ca.contact_id = contacts.id
           AND a.account_type = 'partner'
           ${accountId ? 'AND a.id = ?' : ''}
      )
  `).run(...(accountId ? [accountId] : [])).changes;
}
function cleanRole(r) {
  return CONTACT_ROLES.includes(r) ? r : null;
}

// Every contact currently linked to an account, for duplicate comparison.
function contactsOnAccount(db, accountId) {
  return db.prepare(`
    SELECT c.* FROM contacts c
    JOIN contact_accounts ca ON ca.contact_id = c.id
    WHERE ca.account_id = ?
  `).all(accountId);
}

function queueMergeCandidate(db, accountId, idA, idB, reason, score) {
  const [a, b] = [idA, idB].sort();
  db.prepare(`
    INSERT OR IGNORE INTO contact_merge_candidates
      (account_id, contact_id_a, contact_id_b, reason, score, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(accountId || null, a, b, reason, score);
}

// Attach a contact to an account. Idempotent; sets the role only when given.
function linkAccount(db, contactId, accountId, role, makePrimary) {
  if (!accountId) return;
  const existing = db.prepare(
    'SELECT * FROM contact_accounts WHERE contact_id = ? AND account_id = ?'
  ).get(contactId, accountId);

  if (existing) {
    if (role && !existing.role) {
      db.prepare('UPDATE contact_accounts SET role = ? WHERE id = ?').run(role, existing.id);
    }
  } else {
    db.prepare(`
      INSERT INTO contact_accounts (contact_id, account_id, role, is_primary)
      VALUES (?, ?, ?, 0)
    `).run(contactId, accountId, role || null);
  }
  if (makePrimary) {
    db.prepare('UPDATE contact_accounts SET is_primary = 0 WHERE contact_id = ?').run(contactId);
    db.prepare('UPDATE contact_accounts SET is_primary = 1 WHERE contact_id = ? AND account_id = ?')
      .run(contactId, accountId);
  }
  syncPrimaryAccount(db, contactId);
}

// Fill in fields the existing row is missing. Never clobbers a value a human
// may have typed; the one exception is title, where a longer string is treated
// as more specific ("IT Manager" -> "Global IT Infrastructure Manager").
function enrich(db, existing, incoming) {
  const updates = {};
  for (const f of ['email', 'phone', 'org_name', 'linkedin_url']) {
    const cur = (existing[f] || '').trim();
    const next = (incoming[f] || '').trim();
    if (!cur && next) updates[f] = next;
  }
  const curTitle = (existing.title || '').trim();
  const nextTitle = (incoming.title || '').trim();
  if (nextTitle && nextTitle.length > curTitle.length) updates.title = nextTitle;

  // A human-entered contact never silently reverts to auto-extracted.
  if (existing.auto_extracted && incoming.auto_extracted === 0) updates.auto_extracted = 0;
  if (incoming.contact_type && incoming.contact_type !== 'customer' && existing.contact_type === 'customer') {
    updates.contact_type = incoming.contact_type;
  }

  if (!Object.keys(updates).length) return false;
  updates.updated_at = new Date().toISOString();
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE contacts SET ${sets} WHERE id = ?`).run(...Object.values(updates), existing.id);
  return true;
}

// ---------------------------------------------------------------------------
// upsertContact
//
// Returns { contact, created, action, reason } or null when the input was
// unusable / deliberately skipped. `action` is one of:
//   'created' | 'enriched' | 'unchanged' | 'folded' | 'skipped'
// ---------------------------------------------------------------------------
function upsertContact(db, input) {
  const accountId = input.account_id || null;
  const name = normalizeName(input.name);
  if (!name) return null;
  const key = nameKey(name);
  if (!key) return null;

  const incoming = {
    title: (input.title || '').trim(),
    email: (input.email || '').trim(),
    phone: (input.phone || '').trim(),
    org_name: (input.org_name || '').trim(),
    linkedin_url: normalizeLinkedInUrl(input.linkedin_url) || '',
    contact_type: resolveType(db, input.contact_type, accountId),
    auto_extracted: input.auto_extracted ? 1 : 0
  };
  const role = cleanRole(input.role);
  const fromExtraction = Boolean(input.auto_extracted);

  const peers = accountId ? contactsOnAccount(db, accountId) : [];

  // 1. Exact key match on this account.
  const exact = peers.find(p => p.name_key === key);
  if (exact) {
    const changed = enrich(db, exact, incoming);
    linkAccount(db, exact.id, accountId, role, false);
    return {
      contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(exact.id),
      created: false,
      action: changed ? 'enriched' : 'unchanged'
    };
  }

  // 2/3. Near matches.
  const incomingTokens = tokenCount(name);
  let ambiguous = null;
  for (const p of peers) {
    const cmp = compareNames(p.name, name);
    if (!cmp) continue;
    if (cmp.confident) {
      // Same person, spelled differently -> keep the existing row.
      const changed = enrich(db, p, incoming);
      linkAccount(db, p.id, accountId, role, false);
      return {
        contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(p.id),
        created: false,
        action: changed ? 'enriched' : 'unchanged',
        reason: cmp.reason
      };
    }
    if (!ambiguous || cmp.score > ambiguous.cmp.score) ambiguous = { peer: p, cmp };
  }

  // 4. A single-token name is almost always a transcript speaker label, not a
  // new person. Fold it into an unambiguous match; otherwise drop it rather
  // than pollute the directory with a bare first name.
  if (incomingTokens < 2 && fromExtraction) {
    const firstTokenMatches = peers.filter(p => {
      const pk = (p.name_key || '').split(' ');
      return pk.length > 1 && pk[0] === key;
    });
    if (firstTokenMatches.length === 1) {
      const target = firstTokenMatches[0];
      const changed = enrich(db, target, incoming);
      linkAccount(db, target.id, accountId, role, false);
      return {
        contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(target.id),
        created: false,
        action: changed ? 'enriched' : 'folded',
        reason: 'first_name_folded'
      };
    }
    return { contact: null, created: false, action: 'skipped', reason: 'single_token_name' };
  }

  // Insert. The UNIQUE(account_id, name_key) index makes a concurrent duplicate
  // insert fail rather than succeed, so retry by re-resolving the winner.
  const id = uuid();
  try {
    db.prepare(`
      INSERT INTO contacts
        (id, account_id, name, name_key, title, email, phone, org_name,
         linkedin_url, contact_type, meddpicc_role, auto_extracted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, accountId, name, key,
      incoming.title || null, incoming.email || null, incoming.phone || null,
      incoming.org_name || null, incoming.linkedin_url || null,
      incoming.contact_type, role, incoming.auto_extracted
    );
  } catch (e) {
    if (!/UNIQUE/i.test(e.message)) throw e;
    const winner = db.prepare(
      'SELECT * FROM contacts WHERE account_id = ? AND name_key = ?'
    ).get(accountId, key);
    if (!winner) throw e;
    enrich(db, winner, incoming);
    return {
      contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(winner.id),
      created: false,
      action: 'enriched',
      reason: 'concurrent_insert'
    };
  }

  if (accountId) {
    db.prepare(`
      INSERT INTO contact_accounts (contact_id, account_id, role, is_primary)
      VALUES (?, ?, ?, 1)
    `).run(id, accountId, role || null);
  }

  // Flag the near-miss for review now that both rows exist.
  if (ambiguous) {
    queueMergeCandidate(db, accountId, ambiguous.peer.id, id, ambiguous.cmp.reason, ambiguous.cmp.score);
  }

  return {
    contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(id),
    created: true,
    action: 'created',
    reason: ambiguous ? 'queued_possible_duplicate' : undefined
  };
}

// ---------------------------------------------------------------------------
// Contacts linked to an account, ordered for display.
//
// The role comes from the account *link*, not the contact, so a partner who is
// a champion on one deal isn't labelled that way everywhere. Falls back to the
// contact-level role for rows predating the join table.
//
// customerOnly is what keeps a partner or internal name out of a customer
// deliverable (exports, generated POVs, drafted emails).
// ---------------------------------------------------------------------------
function contactsForAccount(db, accountId, { customerOnly = false } = {}) {
  return db.prepare(`
    SELECT c.id, c.name, c.title, c.email, c.phone, c.org_name, c.contact_type,
           c.linkedin_url, c.auto_extracted, c.created_at,
           COALESCE(ca.role, c.meddpicc_role) AS meddpicc_role,
           ca.is_primary,
           (SELECT COUNT(*) FROM contact_accounts x WHERE x.contact_id = c.id) AS account_count,
           (SELECT COUNT(*) FROM contact_notes n WHERE n.contact_id = c.id) AS note_count
    FROM contacts c
    JOIN contact_accounts ca ON ca.contact_id = c.id
    WHERE ca.account_id = ?
      ${customerOnly ? "AND COALESCE(c.contact_type, 'customer') = 'customer'" : ''}
    ORDER BY
      CASE COALESCE(c.contact_type, 'customer')
        WHEN 'customer' THEN 0 WHEN 'partner' THEN 1
        WHEN 'analyst' THEN 2 ELSE 3 END,
      c.created_at
  `).all(accountId);
}

// Hydrate a contact with its account links and notes for the detail view.
function hydrate(db, contact) {
  if (!contact) return contact;
  const accounts = db.prepare(`
    SELECT ca.account_id, ca.role, ca.is_primary, a.account_name, a.presales_stage, a.color
    FROM contact_accounts ca
    JOIN accounts a ON a.id = ca.account_id
    WHERE ca.contact_id = ?
    ORDER BY ca.is_primary DESC, a.account_name COLLATE NOCASE
  `).all(contact.id);
  const notes = db.prepare(`
    SELECT cn.*, a.account_name
    FROM contact_notes cn
    LEFT JOIN accounts a ON a.id = cn.account_id
    WHERE cn.contact_id = ?
    ORDER BY cn.created_at DESC
  `).all(contact.id);
  return { ...contact, accounts, notes };
}

module.exports = {
  CONTACT_TYPES,
  CONTACT_ROLES,
  cleanType,
  cleanRole,
  resolveType,
  promotePartnerContacts,
  upsertContact,
  linkAccount,
  contactsForAccount,
  hydrate,
  queueMergeCandidate,
  mergeContacts
};
