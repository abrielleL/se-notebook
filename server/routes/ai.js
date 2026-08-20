const express = require('express');
const db = require('../db/database');
const { callAnthropic, getKey, extractJson, DEFAULT_MODEL } = require('../lib/anthropic');
const { normalizeName, nameKey, tokenCount } = require('../lib/contactNames');
const { upsertContact } = require('../lib/contactStore');
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
      // Single-token attendees ("Paul") are kept rather than dropped: the
      // contact store folds them into the matching full name on this account,
      // or skips them when there's no unambiguous match. Anything without a
      // leading capitalized word isn't a name at all.
      if (c.name && c.name.length <= 80 && /^[A-Z][A-Za-z'’.\-]*/.test(c.name)) {
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

// Write a batch of parsed contacts through the shared store.
//
// Deduping the batch by name_key first matters: a single note or transcript
// routinely mentions the same person more than once ("Paul Lospinuso" in the
// attendee list, "Paul" in the body). Collapsing here means the store sees one
// entry per person and the richest variant wins.
function writeContactBatch(accountId, parsedContacts, counts) {
  const byKey = new Map();
  for (const c of parsedContacts) {
    if (!c || !c.name) continue;
    const name = normalizeName(c.name);
    if (!name) continue;
    const key = nameKey(name);
    if (!key) continue;

    const candidate = {
      name,
      title: (c.title || '').trim(),
      org_name: (c.company || c.org_name || '').trim(),
      tokens: tokenCount(name)
    };
    const existing = byKey.get(key);
    // Prefer the fuller name and the more specific title.
    if (!existing) {
      byKey.set(key, candidate);
    } else {
      if (candidate.tokens > existing.tokens) existing.name = candidate.name;
      if (candidate.title.length > existing.title.length) existing.title = candidate.title;
      if (!existing.org_name && candidate.org_name) existing.org_name = candidate.org_name;
    }
  }

  // Longer names first, so "Paul Lospinuso" is created before a bare "Paul"
  // shows up and can be folded into it rather than the other way round.
  const ordered = [...byKey.values()].sort((a, b) => b.tokens - a.tokens);

  const results = [];
  for (const c of ordered) {
    const r = upsertContact(db, {
      account_id: accountId,
      name: c.name,
      title: c.title,
      org_name: c.org_name,
      role: resolveRole(c.title, c.name, counts),
      contact_type: 'customer',
      auto_extracted: 1
    });
    if (!r || !r.contact) {
      if (r) console.log(`[contacts] skipped "${c.name}" (${r.reason})`);
      continue;
    }
    if (r.action === 'unchanged') continue;
    console.log(`[contacts] ${r.action}: ${r.contact.name}${r.reason ? ` (${r.reason})` : ''}`);
    results.push({
      name: r.contact.name,
      title: r.contact.title || '',
      role: r.contact.meddpicc_role || null,
      created: r.created,
      action: r.action
    });
  }
  return results;
}

// Extract + upsert customer contacts from a structured note.
function extractContacts(accountId, raw, allNotes) {
  const { customerContacts } = parseAttendees(raw);
  return writeContactBatch(accountId, customerContacts, customerNameCounts(allNotes));
}

// How much transcript to hand the model. Transcripts here run ~28k chars on
// average and up to ~64k; the previous 2,000-char window saw only the opening
// greetings, which is exactly where people are introduced by first name only
// ("Hey Paul") -- a direct cause of the fragment rows this replaces.
const TRANSCRIPT_HEAD_CHARS = 30000;

// Collect distinct "Speaker:" labels across the whole transcript, so a
// participant who only speaks in the final third still gets seen even when the
// body is truncated.
function speakerLabels(content) {
  const labels = new Set();
  for (const line of String(content || '').split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Za-z'’.\- ]{1,40}?)\s*(?:\(\d{1,2}:\d{2}\))?\s*:/);
    if (m) labels.add(m[1].trim());
  }
  return [...labels].slice(0, 60);
}

// Extract customer participants from a free-form transcript via Anthropic.
async function extractTranscriptContacts(accountId, content, key, allNotes) {
  const system = `Extract the meeting participants from this call transcript. Return JSON only:
{
  "contacts": [
    { "name": string, "title": string, "company": string, "is_customer": boolean }
  ]
}

Rules:
- Give each person's FULL name (first and last) whenever it appears anywhere in the transcript. Speaker labels are often first-name-only; if the full name appears elsewhere, use the full name.
- If you only ever see a first name for someone, still return it, but do not invent a last name.
- Return each person EXACTLY ONCE. Do not output both "Paul" and "Paul Lospinuso" -- pick the fuller name.
- Write names as "First Last", never "Last, First".
- Do not include titles, honorifics, credentials, or parentheticals in the name field.
- title/company: empty string if unknown. Never guess.
- is_customer: true for the customer's own staff; false for OPSWAT employees, resellers, and partners.
No explanation, JSON only.`;

  const body = String(content || '');
  const head = body.slice(0, TRANSCRIPT_HEAD_CHARS);
  const labels = speakerLabels(body);
  const userContent = head +
    (body.length > TRANSCRIPT_HEAD_CHARS ? '\n\n[transcript truncated]' : '') +
    (labels.length ? `\n\nSpeaker labels seen across the full transcript: ${labels.join(', ')}` : '');

  let parsed = {};
  try {
    const text = await callAnthropic({
      key, model: DEFAULT_MODEL, max_tokens: 1200, system,
      messages: [{ role: 'user', content: userContent }]
    });
    parsed = extractJson(text);
  } catch (e) {
    console.warn('[contacts] transcript participant extraction failed:', e.message);
    return [];
  }

  const customerOnly = ((parsed && parsed.contacts) || []).filter(c => c && c.is_customer && c.name);
  return writeContactBatch(accountId, customerOnly, customerNameCounts(allNotes));
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
  const parseOk =
    result.customerContacts.length === 2 &&
    result.customerContacts[0].name === 'John Smith' && result.customerContacts[0].title === 'CISO' &&
    result.customerContacts[1].name === 'Jane Doe' && result.customerContacts[1].title === 'IT Manager' &&
    result.opswatContacts.length === 1 &&
    result.opswatContacts[0].name === 'Mike Johnson' && result.opswatContacts[0].title === 'SE';

  // Guard the name-collapsing rules that the duplicate-contact bug came from.
  // These are pure functions, so they can be checked without touching the DB.
  const { compareNames } = require('../lib/contactNames');
  const sameConfident = (a, b) => {
    const c = compareNames(a, b);
    return Boolean(c && c.confident);
  };
  const sameQueued = (a, b) => {
    const c = compareNames(a, b);
    return Boolean(c && !c.confident);
  };
  const dedupeOk =
    nameKey('Erika Pinczesi -') === nameKey('Erika Pinczesi') &&
    nameKey('Ahmad, Tasneem') === nameKey('Tasneem Ahmad') &&
    nameKey('Dr. Jane Doe  ') === nameKey('Jane Doe') &&
    nameKey('Ron Howell (Guidepoint)') === nameKey('Ron Howell') &&
    sameConfident('Magdy Michael', 'Magdy Michaeel') &&
    sameQueued('Nima', 'Nima Gharehdaghi') &&
    !compareNames('Brian Candage', 'Brian Smith') &&
    !compareNames('Scott Carter', 'Scott Sipkens') &&
    tokenCount('Paul') === 1 && tokenCount('Paul Lospinuso') === 2;

  const ok = parseOk && dedupeOk;
  console.log(`[contacts-test] parser ${parseOk ? 'PASS' : 'FAIL'}, dedupe ${dedupeOk ? 'PASS' : 'FAIL'}`);
  if (!ok) {
    console.warn('[contacts-test] customer:', result.customerContacts, 'opswat:', result.opswatContacts);
  }
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

      // Clear the pending flags only when a key was actually available, i.e.
      // when the deal-intelligence pass above really ran. Clearing them on a
      // keyless request would burn the retry and lose the qualification
      // extraction silently -- the note would look processed but no fields
      // would ever be filled.
      if (key) {
        db.prepare('UPDATE notes SET pending_ai_extraction = 0 WHERE account_id = ? AND pending_ai_extraction = 1')
          .run(req.params.id);
      }
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
