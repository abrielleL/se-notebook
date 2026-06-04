const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const { callAnthropic, getKey, extractJson, DEFAULT_MODEL } = require('../lib/anthropic');
const dealIntel = require('./dealIntelligence');

const router = express.Router();

const FIELDS = dealIntel.DEAL_INTELLIGENCE_FIELDS;

const DEAL_INTEL_SYSTEM_PROMPT = `You are analyzing sales call notes for an enterprise cybersecurity software company. Extract deal qualification information to help the solutions engineer track deal health and identify gaps that could risk the sale.
For each field below, extract any NEW information found ONLY in the [LATEST] note. Do not repeat information already captured in the existing field values shown. Return only fields where genuinely new information was found. If nothing new was found for a field, omit it.

Fields to extract:
- success_metrics: Quantifiable outcomes the customer needs (ROI targets, compliance deadlines, KPIs, risk reduction targets, cost savings)
- decision_maker: Person with final budget authority (name, title, level of engagement, any succession planning risk)
- evaluation_criteria: Technical and business requirements the solution must meet to win
- buying_process: Steps the customer will take to decide (who reviews, who approves, timeline, committee process)
- paper_process: Legal, procurement, and contract workflow (legal review required, PO process, approval chains, typical contract timelines)
- business_pain: Urgent problems driving this evaluation (what breaks if they do nothing, compliance risk, incidents, audit findings, operational pain)
- internal_champion: Person actively advocating for the solution internally (name, title, specific actions they have taken on our behalf)
- competitive_landscape: Alternative solutions being evaluated (competitor names, customer sentiment, where we stand relative to alternatives)

Return JSON only:
{ field_updates: { field_name: 'new content to append' } }
No explanation, no markdown, JSON only.`;

// --- contact extraction helpers ---

// Map a title to an internal qualification role from keyword heuristics.
function roleFromTitle(title = '') {
  const t = title.toLowerCase();
  if (/\b(ciso|cto|cio|ceo|vp|vice president|chief|director|president)\b/.test(t)) return 'decision_maker';
  if (/\b(engineer|architect|developer|technical|analyst)\b/.test(t)) return 'technical_lead';
  if (/\b(manager|admin|administrator|operations|it)\b/.test(t)) return 'technical_lead';
  if (/\b(procurement|legal|finance|contract|purchasing)\b/.test(t)) return 'procurement';
  return null;
}

// champion = referenced as a customer attendee across multiple notes (and not
// already a decision maker by title).
function resolveRole(title, name, counts) {
  const base = roleFromTitle(title);
  if (base !== 'decision_maker' && counts && counts[name.toLowerCase()] >= 2) return 'champion';
  return base;
}

// Robust attendee parser. Handles both "Attendees (Customer):" and the current
// "Attendees:" label, plus "OPSWAT Attendees:". Names follow on subsequent
// lines as "Name, Title" / "Name - Title" / "Name". Capture stops at the next
// section label or separator.
function parseAttendees(noteContent) {
  const lines = String(noteContent || '').split('\n');
  const customerContacts = [];
  const opswatContacts = [];
  let mode = null;

  const splitNameTitle = (line) => {
    const parts = line.split(/,\s*|\s+[-–—]\s+/);
    const name = (parts[0] || '').trim();
    const title = parts.length > 1 ? parts.slice(1).join(', ').trim() : '';
    return { name, title };
  };

  for (const raw of lines) {
    const t = raw.trim();
    if (/^OPSWAT\s+Attendees\s*:/i.test(t)) { mode = 'opswat'; continue; }
    if (/^Attendees(\s*\(\s*Customer\s*\))?\s*:/i.test(t)) { mode = 'customer'; continue; }
    if (/^[─\-_=]{3,}$/.test(t)) { mode = null; continue; }
    if (/^[A-Za-z][A-Za-z ()\/_-]{0,40}:/.test(t)) { mode = null; continue; } // another field label
    if (!t) continue;
    if (mode === 'customer' || mode === 'opswat') {
      const c = splitNameTitle(t);
      // Require a full name (>= 2 words) to avoid stray single-token lines.
      if (c.name && c.name.length <= 80 && c.name.split(/\s+/).length >= 2) {
        (mode === 'customer' ? customerContacts : opswatContacts).push(c);
      }
    }
  }
  return { customerContacts, opswatContacts };
}

// Build a name -> (#notes referencing as customer attendee) map, for champion detection.
function customerNameCounts(notes) {
  const counts = {};
  for (const n of notes || []) {
    for (const c of parseAttendees(n.raw_notes || '').customerContacts) {
      const k = c.name.toLowerCase();
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return counts;
}

// Insert or update a single customer contact. Returns a result row or null.
function upsertContact(accountId, parsed, counts) {
  if (!parsed) return null;
  const name = (parsed.name || '').trim();
  if (!name || name.length > 80) return null;
  const title = (parsed.title || '').trim();

  const existing = db.prepare(
    'SELECT * FROM contacts WHERE account_id = ? AND LOWER(name) = LOWER(?)'
  ).get(accountId, name);

  if (!existing) {
    const id = uuid();
    const role = resolveRole(title, name, counts);
    db.prepare(`
      INSERT INTO contacts (id, account_id, name, title, meddpicc_role, auto_extracted)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(id, accountId, name, title || null, role);
    console.log('[contacts] Created:', name, title);
    return { name, title, role, created: true };
  }
  // Update only when the new title is more specific (longer) than the existing.
  if (title && title.length > (existing.title || '').length) {
    const role = existing.meddpicc_role || resolveRole(title, name, counts);
    db.prepare('UPDATE contacts SET title = ?, meddpicc_role = ? WHERE id = ?')
      .run(title, role, existing.id);
    console.log('[contacts] Updated:', name, 'title changed');
    return { name, title, role, created: false };
  }
  return null;
}

// Extract + upsert customer contacts from a structured note.
function extractContacts(accountId, raw, allNotes) {
  const { customerContacts } = parseAttendees(raw);
  const counts = customerNameCounts(allNotes);
  const results = [];
  for (const c of customerContacts) {
    const r = upsertContact(accountId, c, counts);
    if (r) results.push(r);
  }
  return results;
}

// Extract customer participants from a free-form transcript via Anthropic.
async function extractTranscriptContacts(accountId, content, key, allNotes) {
  const system = `Extract all meeting participants from this transcript. Return JSON only:
{
  contacts: [
    { name: string, title: string, company: string, is_customer: boolean }
  ]
}
Include only people who are explicitly identified in the transcript. If title/company unknown, use empty string. is_customer: true if they appear to be from the customer company, false if OPSWAT.`;
  let parsed = {};
  try {
    const text = await callAnthropic({
      key, model: DEFAULT_MODEL, max_tokens: 800, system,
      messages: [{ role: 'user', content: String(content || '').slice(0, 2000) }]
    });
    parsed = extractJson(text);
  } catch (e) {
    console.warn('[contacts] transcript participant extraction failed:', e.message);
    return [];
  }
  const counts = customerNameCounts(allNotes);
  const results = [];
  for (const c of (parsed && parsed.contacts) || []) {
    if (!c || !c.is_customer || !c.name) continue;
    const r = upsertContact(accountId, { name: c.name, title: c.title || '' }, counts);
    if (r) results.push(r);
  }
  return results;
}

// Dev-only self-test of the attendee parser (runs once at startup).
function runParserSelfTest() {
  const testNote = `Overview: Test meeting

Attendees (Customer):
John Smith, CISO
Jane Doe, IT Manager

OPSWAT Attendees:
Mike Johnson, SE

Follow-up: Send documentation`;
  const result = parseAttendees(testNote);
  console.log('[contacts-test] Customer:', result.customerContacts);
  console.log('[contacts-test] OPSWAT:', result.opswatContacts);
  const ok =
    result.customerContacts.length === 2 &&
    result.customerContacts[0].name === 'John Smith' && result.customerContacts[0].title === 'CISO' &&
    result.customerContacts[1].name === 'Jane Doe' && result.customerContacts[1].title === 'IT Manager' &&
    result.opswatContacts.length === 1 &&
    result.opswatContacts[0].name === 'Mike Johnson' && result.opswatContacts[0].title === 'SE';
  console.log(`[contacts-test] ${ok ? 'PASS' : 'FAIL'}`);
}
if (process.env.NODE_ENV !== 'production') {
  try { runParserSelfTest(); } catch (e) { console.warn('[contacts-test] error:', e.message); }
}

// POST /api/accounts/:id/run-extraction
// Body: { note_id? }. Runs the server-side extractions that need DB access:
// deal-intelligence merge (Anthropic) + contact extraction (heuristic) and
// clears pending_ai_extraction. The existing summary / next-steps / CRM
// snapshot extractions remain client-side and are unchanged.
router.post('/accounts/:id/run-extraction', async (req, res, next) => {
  try {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const body = req.body || {};
    const key = getKey(req);
    console.log(`[contacts] run-extraction account=${req.params.id} note_id=${body.note_id || '-'} transcript_id=${body.transcript_id || '-'} key=${key ? 'yes' : 'no'}`);

    const notes = db.prepare(
      'SELECT * FROM notes WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at ASC'
    ).all(req.params.id);

    let contacts = [];
    const fieldsUpdated = [];

    // --- Note-based extraction (contacts always; deal-intel needs key) ---
    if (notes.length) {
      const latest = body.note_id
        ? notes.find(n => n.id === body.note_id) || notes[notes.length - 1]
        : notes[notes.length - 1];
      const prior = notes.filter(n => n.id !== latest.id);

      console.log('[contacts] latest note raw_notes (first 300):', String(latest.raw_notes || '').slice(0, 300));
      contacts = contacts.concat(extractContacts(req.params.id, latest.raw_notes, notes));

      if (key) {
        const current = {};
        for (const f of FIELDS) current[f] = '';
        db.prepare('SELECT field, value FROM deal_intelligence WHERE account_id = ?')
          .all(req.params.id)
          .forEach(r => { current[r.field] = r.value; });

        const priorText = prior.map(n => `[PRIOR ${n.date}]\n${n.raw_notes || ''}`).join('\n\n');
        const existingValues = FIELDS.map(f => `- ${f}: ${current[f] || '(none)'}`).join('\n');
        const userContent =
          `EXISTING FIELD VALUES (do not repeat):\n${existingValues}\n\n` +
          `${priorText ? priorText + '\n\n' : ''}` +
          `[LATEST ${latest.date}]\n${latest.raw_notes || ''}`;

        try {
          const text = await callAnthropic({
            key, model: DEFAULT_MODEL, max_tokens: 1500,
            system: DEAL_INTEL_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userContent }]
          });
          let parsed = {};
          try { parsed = extractJson(text); } catch { parsed = {}; }
          const updates = (parsed && parsed.field_updates) || {};
          for (const field of FIELDS) {
            const val = updates[field];
            if (val && String(val).trim()) {
              dealIntel.upsertDealIntelligence(req.params.id, field, String(val).trim(), latest.id);
              fieldsUpdated.push(field);
            }
          }
        } catch (e) {
          console.warn('[ai] deal-intelligence extraction failed:', e.message);
        }
      }

      // Clear pending extraction flags for this account's notes.
      db.prepare('UPDATE notes SET pending_ai_extraction = 0 WHERE account_id = ? AND pending_ai_extraction = 1')
        .run(req.params.id);
    }

    // --- Transcript-based participant extraction (needs key) ---
    if (body.transcript_id && key) {
      const t = db.prepare('SELECT * FROM transcripts WHERE id = ? AND account_id = ?')
        .get(body.transcript_id, req.params.id);
      if (t && t.content) {
        const tc = await extractTranscriptContacts(req.params.id, t.content, key, notes);
        contacts = contacts.concat(tc);
      }
    }

    console.log(`[contacts] result: ${contacts.length} contact(s) created/updated, ${fieldsUpdated.length} deal field(s)`);
    res.json({ fields_updated: fieldsUpdated, contacts });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
