const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const opportunities = require('../lib/opportunityStore');
const { getKey } = require('../lib/anthropic');
const { extractUploadText } = require('../lib/extractText');
const { fillDealReview } = require('../lib/dealReviewFill');
const { renderDealReviewDocx, dealReviewFilename } = require('../lib/dealReviewDocx');
const { SECTIONS, BY_KEY, STATUSES, VOICES, APPLIES_LABEL } = require('../lib/dealReviewQuestions');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const DAY = 24 * 60 * 60 * 1000;

// SQLite CURRENT_TIMESTAMP is UTC without a zone marker.
function parseTs(ts) {
  if (!ts) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${String(ts).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const daysSince = (d) => (d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY)) : null);

function quarterOf(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(iso || '');
  return m ? Number(m[1]) * 4 + Math.floor((Number(m[2]) - 1) / 3) : null;
}

// The forecast-calibration facts the app can work out on its own. Anything
// older than the history table is reported as a floor ("at least"), never a
// guess.
function computeForecast(opp) {
  const account = db.prepare('SELECT created_at FROM accounts WHERE id = ?').get(opp.account_id);
  // The default opportunity was backfilled long after its account existed, so
  // its own created_at understates the deal's age; the account's is the truth.
  const born = parseTs(opp.is_default ? (account && account.created_at) || opp.created_at : opp.created_at);

  const history = db.prepare(`
    SELECT field, old_value, new_value, baseline, changed_at FROM opportunity_history
    WHERE opportunity_id = ? ORDER BY changed_at, id
  `).all(opp.id);

  const stageRows = history.filter(h => h.field === 'presales_stage');
  const lastStage = stageRows[stageRows.length - 1];
  let stageSince = born;
  let stageFloor = false;
  if (lastStage) {
    stageSince = parseTs(lastStage.changed_at);
    stageFloor = !!lastStage.baseline;
  }

  const closeRows = history.filter(h => h.field === 'close_date');
  const pushes = closeRows.filter(h => !h.baseline && h.old_value && h.new_value && h.new_value > h.old_value);
  const quarterSlips = pushes.filter(h => quarterOf(h.new_value) > quarterOf(h.old_value));
  const baseline = closeRows.find(h => h.baseline);

  return {
    age_days: daysSince(born),
    created_at: born ? born.toISOString() : null,
    presales_stage: opp.presales_stage,
    days_in_stage: daysSince(stageSince),
    days_in_stage_is_floor: stageFloor,
    close_date: opp.close_date,
    close_date_pushes: pushes.map(h => ({ from: h.old_value, to: h.new_value, at: h.changed_at })),
    quarter_slips: quarterSlips.length,
    tracked_since: baseline ? baseline.changed_at : null
  };
}

function loadAnswers(opportunityId) {
  const out = {};
  for (const row of db.prepare('SELECT * FROM deal_review_answers WHERE opportunity_id = ?').all(opportunityId)) {
    out[row.question_key] = row;
  }
  return out;
}

function resolveOpportunity(accountId, requested) {
  const oppId = opportunities.resolveId(db, accountId, requested);
  return oppId ? db.prepare('SELECT * FROM opportunities WHERE id = ?').get(oppId) : null;
}

// GET the whole review for one deal: the question bank, every answer so far,
// and the computed forecast facts.
router.get('/accounts/:id/deal-review', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const opp = resolveOpportunity(account.id, req.query.opportunity_id);
  if (!opp) return res.status(404).json({ error: 'No opportunity on this account' });

  res.json({
    opportunity: { id: opp.id, name: opp.name },
    sections: SECTIONS,
    applies_labels: APPLIES_LABEL,
    answers: loadAnswers(opp.id),
    forecast: computeForecast(opp),
    internal_calls: listInternalCalls(opp.id),
    source_counts: {
      notes: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE opportunity_id = ? AND deleted_at IS NULL').get(opp.id).n,
      transcripts: db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE opportunity_id = ?').get(opp.id).n
    }
  });
});

// POST: fill the review from the deal's notes, transcripts and internal
// calls. On demand only -- it reads everything and makes one model call per
// section. Locked answers are left alone.
router.post('/accounts/:id/deal-review/refresh', async (req, res, next) => {
  try {
    const opp = resolveOpportunity(req.params.id, req.body && req.body.opportunity_id);
    if (!opp) return res.status(404).json({ error: 'No opportunity on this account' });
    const result = await fillDealReview({ key: getKey(req), opp });
    res.json({ ...result, answers: loadAnswers(opp.id) });
  } catch (e) {
    if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// GET the review as a Word document: this deal's review only, nothing else
// from the account.
router.get('/accounts/:id/deal-review/export', async (req, res, next) => {
  try {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const opp = resolveOpportunity(account.id, req.query.opportunity_id);
    if (!opp) return res.status(404).json({ error: 'No opportunity on this account' });
    // Name the deal only when the account has more than one; otherwise it's
    // just the account's name repeated.
    const showOpportunity = opportunities.countFor(db, account.id) > 1;
    const buffer = await renderDealReviewDocx({
      account, opportunity: opp, sections: SECTIONS, answers: loadAnswers(opp.id),
      forecast: computeForecast(opp), showOpportunity
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${dealReviewFilename(account, opp, showOpportunity)}"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

// --- internal calls -----------------------------------------------------------
// AE/SE conversations about the deal. Read only by the deal review; see the
// internal_calls table in db/database.js for why they're kept apart.

function listInternalCalls(opportunityId) {
  return db.prepare(`
    SELECT id, title, call_date, created_at, length(content) AS chars
    FROM internal_calls WHERE opportunity_id = ?
    ORDER BY COALESCE(call_date, created_at) DESC, created_at DESC
  `).all(opportunityId);
}

router.post('/accounts/:id/internal-calls', upload.single('file'), async (req, res, next) => {
  try {
    const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const opp = resolveOpportunity(account.id, req.body.opportunity_id);
    if (!opp) return res.status(404).json({ error: 'No opportunity on this account' });

    let content = req.body.content || '';
    let title = (req.body.title || '').trim();
    if (req.file) {
      let extracted;
      try { extracted = await extractUploadText(req.file); }
      catch (e) { if (e.status === 400) return res.status(400).json({ error: e.message }); throw e; }
      content = extracted.content;
      if (!title) title = extracted.title;
    }
    if (!content || !content.trim()) return res.status(400).json({ error: 'No call content provided' });

    const id = uuid();
    db.prepare(`
      INSERT INTO internal_calls (id, account_id, opportunity_id, title, call_date, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, account.id, opp.id, title || 'Internal call',
           req.body.call_date || new Date().toISOString().slice(0, 10), content);
    res.status(201).json(listInternalCalls(opp.id));
  } catch (e) { next(e); }
});

router.get('/internal-calls/:callId', (req, res) => {
  const row = db.prepare('SELECT * FROM internal_calls WHERE id = ?').get(req.params.callId);
  if (!row) return res.status(404).json({ error: 'Internal call not found' });
  res.json(row);
});

router.delete('/internal-calls/:callId', (req, res) => {
  const row = db.prepare('SELECT opportunity_id FROM internal_calls WHERE id = ?').get(req.params.callId);
  if (!row) return res.status(404).json({ error: 'Internal call not found' });
  db.prepare('DELETE FROM internal_calls WHERE id = ?').run(req.params.callId);
  res.json(listInternalCalls(row.opportunity_id));
});

// PUT one answer by hand. Body: { opportunity_id?, status, answer?, evidence?,
// voice?, locked? }. A hand edit locks the answer by default so the AI fill
// leaves it alone; pass locked:false to hand it back.
router.put('/accounts/:id/deal-review/:key', (req, res) => {
  const question = BY_KEY.get(req.params.key);
  if (!question) return res.status(400).json({ error: `Unknown question: ${req.params.key}` });
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const opp = resolveOpportunity(account.id, req.body.opportunity_id);
  if (!opp) return res.status(404).json({ error: 'No opportunity on this account' });

  const status = req.body.status || 'unanswered';
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `Invalid status: ${status}` });
  const voice = req.body.voice || null;
  if (voice && !VOICES.includes(voice)) return res.status(400).json({ error: `Invalid voice: ${voice}` });

  const text = (v) => (v == null || !String(v).trim() ? null : String(v).trim());
  const existing = db.prepare('SELECT * FROM deal_review_answers WHERE opportunity_id = ? AND question_key = ?')
    .get(opp.id, question.key);
  // Editing the answer text keeps the AI's evidence and source unless the
  // caller replaces them, so a reworded answer still says where it came from.
  const evidence = 'evidence' in req.body ? text(req.body.evidence) : (existing ? existing.evidence : null);
  const keepSource = existing && !('evidence' in req.body && text(req.body.evidence) !== existing.evidence);

  db.prepare(`
    INSERT INTO deal_review_answers (
      opportunity_id, account_id, question_key, status, answer, evidence,
      source_type, source_id, source_label, source_date, voice, locked, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', CURRENT_TIMESTAMP)
    ON CONFLICT(opportunity_id, question_key) DO UPDATE SET
      status = excluded.status, answer = excluded.answer, evidence = excluded.evidence,
      source_type = excluded.source_type, source_id = excluded.source_id,
      source_label = excluded.source_label, source_date = excluded.source_date,
      voice = excluded.voice, locked = excluded.locked,
      updated_by = 'user', updated_at = CURRENT_TIMESTAMP
  `).run(
    opp.id, account.id, question.key, status, text(req.body.answer), evidence,
    keepSource ? existing.source_type : (evidence ? 'manual' : null),
    keepSource ? existing.source_id : null,
    keepSource ? existing.source_label : null,
    keepSource ? existing.source_date : null,
    voice,
    req.body.locked === false ? 0 : 1
  );

  res.json(db.prepare('SELECT * FROM deal_review_answers WHERE opportunity_id = ? AND question_key = ?')
    .get(opp.id, question.key));
});

// DELETE clears an answer back to unanswered (and unlocked).
router.delete('/accounts/:id/deal-review/:key', (req, res) => {
  const opp = resolveOpportunity(req.params.id, req.query.opportunity_id);
  if (!opp) return res.status(404).json({ error: 'No opportunity on this account' });
  db.prepare('DELETE FROM deal_review_answers WHERE opportunity_id = ? AND question_key = ?')
    .run(opp.id, req.params.key);
  res.json({ ok: true });
});

module.exports = router;
module.exports.computeForecast = computeForecast;
