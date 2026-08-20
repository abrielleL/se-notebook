// ---------------------------------------------------------------------------
// Contacts migration: account-scoped rows -> first-class people.
//
// Runs once per startup, idempotently. Three jobs:
//
//   1. Backfill `name_key` on every contact and clean up malformed display
//      names (trailing separators, "Last, First", stray whitespace).
//   2. Populate `contact_accounts` from the legacy `contacts.account_id` so
//      every existing contact keeps exactly the link it had, marked primary.
//   3. Collapse duplicates. Only unambiguous matches merge automatically;
//      judgment calls are written to `contact_merge_candidates` for review in
//      the directory UI.
//
// `contacts.account_id` is retained as the *primary* account. It is what the
// FTS triggers index against (search_index needs one account per row) and is
// kept in sync with the is_primary row in contact_accounts. contact_accounts
// remains the source of truth for "which accounts is this person on".
// ---------------------------------------------------------------------------

const { normalizeName, nameKey, compareNames } = require('../lib/contactNames');

function migrateContacts(db) {
  // --- 1. Backfill normalized names + keys -------------------------------
  const needKeys = db.prepare(
    "SELECT id, name, name_key FROM contacts WHERE name_key IS NULL OR name_key = ''"
  ).all();

  if (needKeys.length) {
    const updateName = db.prepare('UPDATE contacts SET name = ?, name_key = ? WHERE id = ?');
    const dropRow = db.prepare('DELETE FROM contacts WHERE id = ?');
    db.transaction(() => {
      for (const c of needKeys) {
        const norm = normalizeName(c.name);
        const key = nameKey(c.name);
        // A row whose name normalizes to nothing was never a real person
        // (separator debris, a stray number). Drop it rather than keep a
        // contact with an empty key that can never dedupe.
        if (!norm || !key) { dropRow.run(c.id); continue; }
        updateName.run(norm, key, c.id);
      }
    })();
    console.log(`[contacts-migration] normalized ${needKeys.length} contact name(s)`);
  }

  // --- 2. Backfill contact_accounts from legacy account_id ---------------
  const unlinked = db.prepare(`
    SELECT c.id, c.account_id, c.meddpicc_role
    FROM contacts c
    WHERE c.account_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM contact_accounts ca
        WHERE ca.contact_id = c.id AND ca.account_id = c.account_id
      )
  `).all();

  if (unlinked.length) {
    const link = db.prepare(`
      INSERT OR IGNORE INTO contact_accounts (contact_id, account_id, role, is_primary)
      VALUES (?, ?, ?, 1)
    `);
    db.transaction(() => {
      for (const c of unlinked) link.run(c.id, c.account_id, c.meddpicc_role || null);
    })();
    console.log(`[contacts-migration] linked ${unlinked.length} contact(s) to their account`);
  }

  // --- 3. Duplicate collapse --------------------------------------------
  // Duplicates are only meaningful within an account: two "John Smith" rows on
  // different accounts are two different people until the user says otherwise.
  const accountIds = db.prepare(
    'SELECT DISTINCT account_id FROM contact_accounts WHERE account_id IS NOT NULL'
  ).all().map(r => r.account_id);

  let merged = 0;
  let queued = 0;

  const queueCandidate = db.prepare(`
    INSERT OR IGNORE INTO contact_merge_candidates
      (account_id, contact_id_a, contact_id_b, reason, score, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);

  for (const accountId of accountIds) {
    const rows = db.prepare(`
      SELECT c.* FROM contacts c
      JOIN contact_accounts ca ON ca.contact_id = c.id
      WHERE ca.account_id = ?
      ORDER BY c.auto_extracted ASC, LENGTH(COALESCE(c.title,'')) DESC, c.created_at ASC
    `).all(accountId);

    // The ordering above puts the best-quality row first, so the survivor of
    // any pair is whichever we encounter earlier: manually-entered beats
    // auto-extracted, and a row with a title beats one without.
    const alive = [];
    for (const row of rows) {
      let absorbed = false;
      for (const keeper of alive) {
        const cmp = compareNames(keeper.name, row.name);
        if (!cmp) continue;
        if (cmp.confident) {
          mergeContacts(db, keeper.id, row.id);
          merged++;
          absorbed = true;
        } else {
          // Store the pair with a stable ordering so the UNIQUE index actually
          // prevents re-queueing the same pair on the next startup.
          const [a, b] = [keeper.id, row.id].sort();
          const info = queueCandidate.run(accountId, a, b, cmp.reason, cmp.score);
          if (info.changes) queued++;
        }
        break;
      }
      if (!absorbed) alive.push(row);
    }
  }

  if (merged || queued) {
    console.log(`[contacts-migration] auto-merged ${merged} duplicate(s), queued ${queued} for review`);
  }

  // Drop candidate rows whose contacts no longer exist (merged away elsewhere).
  db.exec(`
    DELETE FROM contact_merge_candidates
    WHERE contact_id_a NOT IN (SELECT id FROM contacts)
       OR contact_id_b NOT IN (SELECT id FROM contacts);
  `);
}

// ---------------------------------------------------------------------------
// Merge `loserId` into `keeperId`: move account links and notes across, fill
// any field the keeper is missing, then delete the loser. Exported because the
// merge API endpoint and the review UI use the exact same path.
// ---------------------------------------------------------------------------
function mergeContacts(db, keeperId, loserId) {
  if (keeperId === loserId) return null;
  const keeper = db.prepare('SELECT * FROM contacts WHERE id = ?').get(keeperId);
  const loser = db.prepare('SELECT * FROM contacts WHERE id = ?').get(loserId);
  if (!keeper || !loser) return null;

  const run = db.transaction(() => {
    // Move account links the keeper doesn't already have. Preserve the loser's
    // role where the keeper's link has none.
    const loserLinks = db.prepare('SELECT * FROM contact_accounts WHERE contact_id = ?').all(loserId);
    for (const l of loserLinks) {
      const existing = db.prepare(
        'SELECT * FROM contact_accounts WHERE contact_id = ? AND account_id = ?'
      ).get(keeperId, l.account_id);
      if (existing) {
        if (!existing.role && l.role) {
          db.prepare('UPDATE contact_accounts SET role = ? WHERE id = ?').run(l.role, existing.id);
        }
      } else {
        db.prepare(`
          INSERT INTO contact_accounts (contact_id, account_id, role, is_primary)
          VALUES (?, ?, ?, 0)
        `).run(keeperId, l.account_id, l.role || null);
      }
    }
    db.prepare('DELETE FROM contact_accounts WHERE contact_id = ?').run(loserId);

    // Notes follow the person.
    db.prepare('UPDATE contact_notes SET contact_id = ? WHERE contact_id = ?').run(keeperId, loserId);

    // Fill gaps on the keeper from the loser -- never overwrite a value the
    // keeper already has, except to prefer a longer (more specific) title.
    const updates = {};
    for (const f of ['title', 'email', 'phone', 'org_name', 'linkedin_url']) {
      const kv = (keeper[f] || '').trim();
      const lv = (loser[f] || '').trim();
      if (!kv && lv) updates[f] = lv;
      else if (f === 'title' && lv.length > kv.length) updates[f] = lv;
    }
    if (!keeper.meddpicc_role && loser.meddpicc_role) updates.meddpicc_role = loser.meddpicc_role;
    // A manually-entered row absorbing an auto-extracted one stays manual.
    if (keeper.auto_extracted && !loser.auto_extracted) updates.auto_extracted = 0;

    if (Object.keys(updates).length) {
      const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE contacts SET ${sets} WHERE id = ?`)
        .run(...Object.values(updates), keeperId);
    }

    // Any queued candidate mentioning the loser is now resolved.
    db.prepare(`
      DELETE FROM contact_merge_candidates WHERE contact_id_a = ? OR contact_id_b = ?
    `).run(loserId, loserId);

    db.prepare('DELETE FROM contacts WHERE id = ?').run(loserId);

    // Keep the denormalized primary account consistent after link moves.
    syncPrimaryAccount(db, keeperId);
  });
  run();

  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(keeperId);
}

// ---------------------------------------------------------------------------
// Keep contacts.account_id (the primary account, used by the FTS triggers)
// pointing at the is_primary link -- or at the oldest link if none is flagged.
// ---------------------------------------------------------------------------
function syncPrimaryAccount(db, contactId) {
  const links = db.prepare(
    'SELECT * FROM contact_accounts WHERE contact_id = ? ORDER BY is_primary DESC, created_at ASC, id ASC'
  ).all(contactId);

  if (!links.length) {
    db.prepare('UPDATE contacts SET account_id = NULL WHERE id = ?').run(contactId);
    return null;
  }
  const primary = links[0];
  // Exactly one link carries is_primary.
  db.prepare('UPDATE contact_accounts SET is_primary = 0 WHERE contact_id = ?').run(contactId);
  db.prepare('UPDATE contact_accounts SET is_primary = 1 WHERE id = ?').run(primary.id);
  db.prepare('UPDATE contacts SET account_id = ? WHERE id = ?').run(primary.account_id, contactId);
  return primary.account_id;
}

module.exports = { migrateContacts, mergeContacts, syncPrimaryAccount };
