const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const { PRESALES_STAGES } = require('../lib/stages');

const router = express.Router();

// Account card colors, cycled on creation.
const ACCOUNT_COLORS = ['#378ADD', '#BA7517', '#639922', '#534AB7', '#1D9E75', '#D85A30'];

// Fields accepted on PUT (existing + new).
const EDITABLE_FIELDS = [
  'account_name', 'account_executive', 'industry', 'opportunity_stage',
  'ai_summary', 'ai_technical_drivers', 'ai_environment', 'ai_summary_updated_at',
  'risk', 'presales_stage', 'escalation', 'jira_ticket_url', 'close_date',
  'opportunity_value', 'ae_name', 'pov_success_plan_url', 'color'
];

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
  res.json(accounts);
});

router.post('/', (req, res) => {
  const { account_name, account_executive, industry, opportunity_stage, presales_stage } = req.body;
  if (!account_name) return res.status(400).json({ error: 'account_name required' });
  if (presales_stage && !PRESALES_STAGES.includes(presales_stage)) {
    return res.status(400).json({ error: `Invalid presales_stage: ${presales_stage}` });
  }

  const id = uuid();
  const count = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  const color = ACCOUNT_COLORS[count % ACCOUNT_COLORS.length];

  db.prepare(`
    INSERT INTO accounts (id, account_name, account_executive, industry, opportunity_stage, presales_stage, color)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, account_name, account_executive || null, industry || null, opportunity_stage || null, presales_stage || null, color);

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  res.status(201).json(account);
});

router.get('/:id', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  account.contacts = db.prepare('SELECT * FROM contacts WHERE account_id = ? ORDER BY created_at').all(account.id);
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

  res.json(account);
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
  if (!updates.length) return res.json(existing);
  values.push(req.params.id);
  db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  res.json(account);
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
