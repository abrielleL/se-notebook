const express = require('express');
const db = require('../db/database');
const { PRESALES_STAGES } = require('../lib/stages');
const store = require('../lib/opportunityStore');

const router = express.Router();

const CHILD_TABLES = [
  'notes', 'transcripts', 'next_steps', 'meetings', 'pov_drafts',
  'pov_jobs', 'stage_gate_progress', 'deal_intelligence', 'crm_snapshots'
];

function contentCount(opportunityId) {
  return CHILD_TABLES.reduce((total, table) => total +
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE opportunity_id = ?`).get(opportunityId).n, 0);
}

router.get('/accounts/:accountId/opportunities', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json(store.listForAccount(db, account.id));
});

// Adding the second opportunity to an account is the moment it splits into a
// company with deals under it, so this is also the only good moment to name
// the work that was already there — "Kiosk & MFT" is obvious today and
// unrecoverable in six months. `rename_existing` carries that name, and the
// two renames happen in the same transaction as the create so the page can
// never render half-split.
router.post('/accounts/:accountId/opportunities', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  if (req.body.presales_stage && !PRESALES_STAGES.includes(req.body.presales_stage)) {
    return res.status(400).json({ error: `Invalid presales_stage: ${req.body.presales_stage}` });
  }

  const renameExisting = (req.body.rename_existing || '').trim();

  const run = db.transaction(() => {
    if (renameExisting) {
      const existing = store.defaultFor(db, account.id);
      if (existing) {
        db.prepare('UPDATE opportunities SET name = ? WHERE id = ?').run(renameExisting, existing.id);
      }
    }
    const seed = { name };
    for (const f of ['presales_stage', 'close_date', 'opportunity_value', 'risk', 'sugar_opportunity_id']) {
      if (req.body[f] !== undefined && req.body[f] !== '') seed[f] = req.body[f];
    }
    // A brand-new deal starts at the first stage unless told otherwise; an
    // account's existing stage belongs to the deal that earned it.
    if (seed.presales_stage === undefined) seed.presales_stage = PRESALES_STAGES[0] || null;
    if (seed.risk === undefined) seed.risk = 'green';
    const created = store.create(db, account.id, seed);
    store.mirrorToAccount(db, account.id);
    return created;
  });

  res.status(201).json(run());
});

router.put('/opportunities/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Opportunity not found' });

  if ('presales_stage' in req.body && req.body.presales_stage
      && !PRESALES_STAGES.includes(req.body.presales_stage)) {
    return res.status(400).json({ error: `Invalid presales_stage: ${req.body.presales_stage}` });
  }
  if ('name' in req.body && !(req.body.name || '').trim()) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }

  const updates = [];
  const values = [];
  for (const field of store.EDITABLE_FIELDS) {
    if (field in req.body) {
      updates.push(`${field} = ?`);
      values.push(req.body[field] === '' ? null : req.body[field]);
    }
  }
  if (!updates.length) return res.json(existing);

  db.transaction(() => {
    db.prepare(`UPDATE opportunities SET ${updates.join(', ')} WHERE id = ?`).run(...values, req.params.id);
    store.mirrorToAccount(db, existing.account_id);
  })();

  res.json(db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id));
});

// Closing a deal archives it in the same move: off the board, still on the
// company page, still readable, and still available to the AI context toggle.
router.post('/opportunities/:id/close', (req, res) => {
  const existing = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Opportunity not found' });

  const status = req.body.status;
  if (!store.OUTCOMES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${store.OUTCOMES.join(', ')}` });
  }

  db.transaction(() => {
    store.setOutcome(db, req.params.id, status);
    store.mirrorToAccount(db, existing.account_id);
  })();

  res.json(db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id));
});

router.post('/opportunities/:id/reopen', (req, res) => {
  const existing = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Opportunity not found' });

  db.transaction(() => {
    store.setOutcome(db, req.params.id, null);
    store.mirrorToAccount(db, existing.account_id);
  })();

  res.json(db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id));
});

// Splitting an account has to be undoable, or it becomes a decision you avoid
// making. Deleting the second opportunity folds the page back to its flat
// form — but only while it is still empty, because opportunity_id cascades and
// a careless delete would take notes and steps with it. A deal with content is
// closed, not deleted.
router.delete('/opportunities/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Opportunity not found' });

  if (store.countFor(db, existing.account_id) < 2) {
    return res.status(400).json({ error: 'An account must keep at least one opportunity.' });
  }
  const content = contentCount(req.params.id);
  if (content > 0) {
    return res.status(400).json({
      error: `This opportunity holds ${content} item${content === 1 ? '' : 's'}. Close it as won or lost instead of deleting it.`
    });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM opportunities WHERE id = ?').run(req.params.id);
    store.mirrorToAccount(db, existing.account_id);
  })();

  res.json({ deleted: req.params.id });
});

// Moving content between deals: the escape hatch for a note filed against the
// wrong opportunity, and for the first split, where some of the existing work
// genuinely belongs to the new deal.
router.post('/opportunities/:id/move', (req, res) => {
  const target = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Opportunity not found' });

  const { table, ids } = req.body;
  if (!CHILD_TABLES.includes(table)) return res.status(400).json({ error: `Unknown table: ${table}` });
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });

  // Scoped to the same account, so a move can never pull another company's
  // content into this deal.
  const update = db.prepare(`
    UPDATE ${table} SET opportunity_id = ? WHERE id = ? AND account_id = ?
  `);
  let moved = 0;
  db.transaction(() => {
    for (const id of ids) moved += update.run(req.params.id, id, target.account_id).changes;
  })();

  res.json({ moved });
});

module.exports = router;
