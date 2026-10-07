// Evidence-based deal review fill: two stages instead of one big read.
//
// Stage 1 (reading): every note, transcript and internal call is cut into
// numbered segments (speaker turns, paragraphs) and read on its own, long
// ones in parts. The model picks segments by number and tags each with the
// review section it supports -- it never writes the excerpt, so excerpts are
// always the source's own words. Each is stored with its neighbors as context
// and its speaker, taken from the transcript's ">>Name 00:00" labels and
// matched against the account's contacts and the OPSWAT roster. Results are
// kept per provider and per source content hash, so a refresh only re-reads
// what is new or changed.
//
// Stage 2 (answering): each section is answered from the stored excerpts plus
// facts the notebook already holds (contacts and their roles, next steps,
// partners, POV, close-date history). The model cites excerpt and fact ids
// instead of retyping quotes, so a quote shown on the tab is always a
// segment of the source.
//
// Then plain server rules, the same for every model: "answered" needs a
// citation; questions that ask for the customer's own words need a customer
// speaker; a deal-killer can only be "clear" with evidence; and a few
// deal-killers are set straight from the notebook's records.

const crypto = require('crypto');
const db = require('../db/database');
const llm = require('./llm');
const { callAnthropicMessage, extractJson } = require('./anthropic');
const { SECTIONS, BY_KEY, APPLIES_LABEL } = require('./dealReviewQuestions');
const { nameKey } = require('./contactNames');
const { listRoster } = require('./aeRoster');
const seProfile = require('./seProfile');

const ANTHROPIC_MODEL = 'claude-opus-5-5';
const ANTHROPIC_PARALLEL = 4;

// Local context budgeting, at a cautious 3 characters per token: transcripts
// (names, timestamps) tokenize densely, and an overflow fails the call.
const CHARS_PER_TOKEN = 3;
const READ_OUTPUT_TOKENS = 5000;
const ANSWER_OUTPUT_TOKENS = 5000;
const ANTHROPIC_CHUNK_CHARS = 300000;
// Sources shorter than this are grouped into one reading call (notes, mostly);
// anything longer is read on its own, so a long call gets the model's full
// attention instead of sharing one answer's worth of excerpts with others.
const GROUP_UNDER_CHARS = 12000;

const SECTION_KEYS = SECTIONS.map(s => s.key);

// --- progress, for the tab's "Reading 3 of 7" ---------------------------------

const progress = new Map();
const setProgress = (oppId, p) => progress.set(oppId, { ...p, at: Date.now() });
const getProgress = (oppId) => progress.get(oppId) || null;

// --- model calls ------------------------------------------------------------------

async function askJson({ provider, key, local, system, user, schema, name, maxTokens }) {
  if (provider === 'local') {
    const text = await llm.callLocal({
      config: local, system, max_tokens: maxTokens,
      messages: [{ role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }
    });
    return { parsed: extractJson(text) };
  }
  const msg = await callAnthropicMessage({
    key, model: ANTHROPIC_MODEL, max_tokens: 16000,
    // The system block is identical across a stage's calls, so it caches.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } }
  });
  return { parsed: JSON.parse(msg.text), usage: msg.usage };
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

// --- sources ------------------------------------------------------------------------

const hash = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex');

function loadSources(opp) {
  const out = [];
  db.prepare(`
    SELECT id, date, raw_notes FROM notes
    WHERE opportunity_id = ? AND deleted_at IS NULL AND raw_notes IS NOT NULL AND trim(raw_notes) <> ''
    ORDER BY date, created_at
  `).all(opp.id).forEach(n => out.push({
    type: 'note', id: n.id, date: n.date, label: `Note ${n.date}`, kind: 'SE note', text: n.raw_notes
  }));
  db.prepare(`
    SELECT id, title, call_date, created_at, content FROM transcripts
    WHERE opportunity_id = ? ORDER BY COALESCE(call_date, created_at), created_at
  `).all(opp.id).forEach(t => out.push({
    type: 'transcript', id: t.id, date: t.call_date || (t.created_at || '').slice(0, 10),
    label: (t.title || 'Transcript').trim(), kind: 'customer call transcript', text: t.content
  }));
  db.prepare(`
    SELECT id, title, call_date, created_at, content FROM internal_calls
    WHERE opportunity_id = ? ORDER BY COALESCE(call_date, created_at), created_at
  `).all(opp.id).forEach(c => out.push({
    type: 'internal_call', id: c.id, date: c.call_date || (c.created_at || '').slice(0, 10),
    label: (c.title || 'Internal call').trim(), kind: 'internal call (OPSWAT team only)', text: c.content
  }));
  for (const s of out) s.hash = hash(s.text);
  return out;
}

// --- segments ---------------------------------------------------------------------------
//
// Each source is cut into numbered segments: one speaker turn in a
// transcript, or a paragraph in a note, with long ones split at sentence
// ends. The model picks segments by number instead of copying text, so an
// excerpt is always the source's own words (a model asked to copy messy
// speech-to-text tidies it up, or invents lines outright), and the speaker
// comes from the turn it sits in.

const SEGMENT_MAX_CHARS = 300;

// ">>Name<tab>00:00" (Clari Copilot and its exports), or a "Name 00:00" line.
const SPEAKER_PATTERNS = [
  />>\s*([^\t\n>]{1,60}?)\s+\(?\d{1,2}:\d{2}(?::\d{2})?\)?/g,
  /^([A-Z][^\n:]{1,50}?)\s+\(?\d{1,2}:\d{2}(?::\d{2})?\)?[ \t]*$/gm
];

function speakerTurns(text) {
  const marks = [];
  for (const re of SPEAKER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) marks.push({ at: m.index, after: m.index + m[0].length, name: m[1].trim() });
  }
  marks.sort((a, b) => a.at - b.at);
  if (!marks.length) return null;
  const turns = [];
  if (marks[0].at > 0) turns.push({ speaker: null, text: text.slice(0, marks[0].at) });
  marks.forEach((m, i) => turns.push({ speaker: m.name, text: text.slice(m.after, i + 1 < marks.length ? marks[i + 1].at : text.length) }));
  return turns;
}

// Split at sentence ends into pieces of at most SEGMENT_MAX_CHARS.
function splitLong(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= SEGMENT_MAX_CHARS) return t ? [t] : [];
  const sentences = t.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [t];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > SEGMENT_MAX_CHARS) { out.push(cur.trim()); cur = ''; }
    if (s.length > SEGMENT_MAX_CHARS) {
      for (let i = 0; i < s.length; i += SEGMENT_MAX_CHARS) out.push(s.slice(i, i + SEGMENT_MAX_CHARS).trim());
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function segmentSource(src) {
  if (src._segments) return src._segments;
  const turns = src.type === 'note' ? null : speakerTurns(src.text);
  const blocks = turns || src.text.split(/\n\s*\n|\n(?=\s*[-*•]\s)/).map(t => ({ speaker: null, text: t }));
  const segs = [];
  for (const b of blocks) for (const piece of splitLong(b.text)) segs.push({ speaker: b.speaker, text: piece });
  src._segments = segs;
  return segs;
}

// --- speakers ---------------------------------------------------------------------------

// Who's who on this account: customer and partner contacts, plus OPSWAT
// people (the AE roster, this notebook's SE, the account's AE).
function peopleDirectory(opp) {
  const people = [];
  const add = (name, side) => { const k = nameKey(name); if (k) people.push({ key: k, first: k.split(' ')[0], side, name }); };
  db.prepare(`
    SELECT c.name, COALESCE(c.contact_type, 'customer') AS type
    FROM contacts c JOIN contact_accounts ca ON ca.contact_id = c.id WHERE ca.account_id = ?
  `).all(opp.account_id).forEach(c => add(c.name,
    c.type === 'customer' ? 'customer' : c.type === 'partner' ? 'partner' : c.type === 'internal' ? 'opswat' : 'unknown'));
  db.prepare(`
    SELECT c.name FROM account_partners p
    JOIN contact_accounts ca ON ca.account_id = p.partner_id JOIN contacts c ON c.id = ca.contact_id
    WHERE p.account_id = ?
  `).all(opp.account_id).forEach(c => add(c.name, 'partner'));
  for (const r of listRoster()) add(r.full_name, 'opswat');
  const se = seProfile.read();
  if (se && se.name) add(se.name, 'opswat');
  const acct = db.prepare('SELECT ae_name, account_executive FROM accounts WHERE id = ?').get(opp.account_id);
  if (acct) { if (acct.ae_name) add(acct.ae_name, 'opswat'); if (acct.account_executive) add(acct.account_executive, 'opswat'); }
  return people;
}

// Exact name first; a bare first name only when it points at one side.
function sideFromDirectory(name, people) {
  const k = nameKey(name);
  if (!k) return null;
  const exact = people.filter(p => p.key === k);
  if (exact.length) return exact[0].side;
  if (!k.includes(' ')) {
    const sides = new Set(people.filter(p => p.first === k).map(p => p.side));
    if (sides.size === 1) return [...sides][0];
  }
  return null;
}

// --- stage 1: reading -------------------------------------------------------------------

function sectionGuide() {
  return SECTIONS.map(s => {
    const qs = s.questions.map(q => `   - ${q.text}`).join('\n');
    return `${s.key} — ${s.number}. ${s.title}${s.killer ? ' (risks that could kill the deal)' : ''}\n${qs}`;
  }).join('\n\n');
}

const READ_SYSTEM = `You are reading source material from an OPSWAT sales deal to collect evidence for a deal review. OPSWAT sells cybersecurity products for critical infrastructure and enterprise IT: MetaDefender (multiscanning, Deep CDR, sandboxing), MetaDefender Kiosk and other removable-media controls, Managed File Transfer, Unidirectional and Bilateral Security Gateways (data diodes), DLP, and OT/ICS security.

The source is split into numbered segments like "[12] Speaker: text". Pick the segments that are evidence for the review questions below, and tag each with the section it supports. Rules:
- Refer to segments only by their number. Never write or rewrite text.
- Tag a segment with every section it is real evidence for (list it once per section).
- Prefer substance: problems and their impact, deadlines, numbers, who decides and how, budget, competitors and alternatives, objections, requirements, test results, commitments, risks. Skip greetings, small talk, scheduling chatter and filler.
- Be thorough: a full call usually has 15 to 40 useful segments; a short note a handful. At most 8 per section per source.
- Also list every named speaker and whether they are the customer, OPSWAT, or a partner/reseller, judging from what they say.

Review sections and their questions:

${sectionGuide()}`;

const READ_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['speakers', 'picks'],
  properties: {
    speakers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'side'],
        properties: { name: { type: 'string' }, side: { type: 'string', enum: ['customer', 'opswat', 'partner', 'unknown'] } }
      }
    },
    picks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['segment', 'section'],
        properties: { segment: { type: 'integer' }, section: { type: 'string', enum: SECTION_KEYS } }
      }
    }
  }
};

// Read batches. A batch is a list of { src, from, to } segment ranges, with
// segment numbers running on across the batch. Long sources are split into
// ranges that fit; short ones (notes, mostly) share a batch.
function readBatches(sources, chunkChars) {
  const batches = [];
  let current = [];
  let size = 0;
  const flush = () => { if (current.length) batches.push(current); current = []; size = 0; };
  for (const src of sources) {
    const segs = segmentSource(src);
    if (!segs.length) continue;
    const total = segs.reduce((n, s) => n + s.text.length + 30, 0);
    if (total >= GROUP_UNDER_CHARS) {
      flush();
      let from = 0;
      let used = 0;
      segs.forEach((s, i) => {
        const len = s.text.length + 30;
        if (used + len > chunkChars && i > from) { batches.push([{ src, from, to: i }]); from = i; used = 0; }
        used += len;
      });
      batches.push([{ src, from, to: segs.length }]);
      continue;
    }
    if (size + total > Math.min(chunkChars, GROUP_UNDER_CHARS * 2)) flush();
    current.push({ src, from: 0, to: segs.length });
    size += total;
  }
  flush();
  return batches;
}

// Render a batch, numbering segments 1..n across it, and return the lookup
// from number back to source and segment.
function batchPrompt(batch) {
  const lookup = new Map();
  let n = 0;
  const parts = batch.map(r => {
    const segs = segmentSource(r.src).slice(r.from, r.to);
    const lines = segs.map((s, i) => {
      n++;
      lookup.set(n, { src: r.src, index: r.from + i });
      return `[${n}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`;
    });
    return `<source type="${r.src.kind}" date="${r.src.date || 'unknown'}" title="${String(r.src.label).replace(/"/g, "'")}">\n${lines.join('\n')}\n</source>`;
  });
  return { text: parts.join('\n\n'), lookup };
}

const neighbor = (segs, i) => (segs[i] ? `${segs[i].speaker ? `${segs[i].speaker}: ` : ''}${segs[i].text}` : '');

// Read the sources that are new or changed since this provider last read
// them, and store the picked segments as evidence.
async function readSources({ opp, provider, key, local, sources, people, onBatch }) {
  const done = new Map(db.prepare(`
    SELECT source_type, source_id, content_hash FROM deal_review_source_runs WHERE opportunity_id = ? AND provider = ?
  `).all(opp.id, provider).map(r => [`${r.source_type}:${r.source_id}`, r.content_hash]));
  const todo = sources.filter(s => done.get(`${s.type}:${s.id}`) !== s.hash);

  // Forget evidence from sources that no longer exist (deleted notes etc.).
  const live = new Set(sources.map(s => `${s.type}:${s.id}`));
  for (const r of db.prepare('SELECT DISTINCT source_type, source_id FROM deal_review_source_runs WHERE opportunity_id = ? AND provider = ?').all(opp.id, provider)) {
    if (!live.has(`${r.source_type}:${r.source_id}`)) {
      db.prepare('DELETE FROM deal_review_evidence WHERE opportunity_id = ? AND provider = ? AND source_type = ? AND source_id = ?')
        .run(opp.id, provider, r.source_type, r.source_id);
      db.prepare('DELETE FROM deal_review_source_runs WHERE opportunity_id = ? AND provider = ? AND source_type = ? AND source_id = ?')
        .run(opp.id, provider, r.source_type, r.source_id);
    }
  }
  if (!todo.length) return { read: 0, proposed: 0, verified: 0, errors: [] };

  const chunkChars = provider === 'local'
    ? Math.max(4000, (local.local_context_tokens - llm.estimateTokens(READ_SYSTEM) - READ_OUTPUT_TOKENS - 500) * CHARS_PER_TOKEN)
    : ANTHROPIC_CHUNK_CHARS;
  const batches = readBatches(todo, chunkChars);

  // Per source: everything its batches picked, merged before writing, so a
  // long transcript read in parts is replaced in one go.
  const found = new Map(todo.map(s => [s, { picks: [], speakers: [], proposed: 0, failed: false }]));
  const errors = [];
  let finished = 0;

  const runBatch = async (batch) => {
    try {
      const { text, lookup } = batchPrompt(batch);
      const { parsed } = await askJson({
        provider, key, local, system: READ_SYSTEM, user: text,
        schema: READ_SCHEMA, name: 'deal_review_read', maxTokens: READ_OUTPUT_TOKENS
      });
      for (const sp of (parsed.speakers || [])) for (const r of batch) found.get(r.src).speakers.push(sp);
      for (const p of (parsed.picks || [])) {
        const hit = lookup.get(Number(p.segment));
        const target = hit ? found.get(hit.src) : found.get(batch[0].src);
        target.proposed++;
        if (hit && SECTION_KEYS.includes(p.section)) target.picks.push({ index: hit.index, section: p.section });
      }
    } catch (e) {
      errors.push({ source: batch.map(r => r.src.label).join(', '), error: e.message });
      for (const r of batch) found.get(r.src).failed = true;
    }
    finished++;
    onBatch && onBatch(finished, batches.length);
  };

  // Locally one at a time; on Anthropic the first call writes the cache for
  // the (large, shared) instructions and the rest read it.
  if (provider === 'local') await inBatches(batches, 1, runBatch);
  else { await runBatch(batches[0]); await inBatches(batches.slice(1), ANTHROPIC_PARALLEL, runBatch); }

  if (errors.length === batches.length) {
    const e = new Error(errors[0].error);
    e.status = /API key|error 40[13]/.test(errors[0].error) ? 400 : 502;
    throw e;
  }

  let proposed = 0;
  let verified = 0;
  const insert = db.prepare(`
    INSERT INTO deal_review_evidence (opportunity_id, account_id, provider, source_type, source_id, source_label, source_date,
      section_key, excerpt, context, speaker, speaker_side)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const write = db.transaction(() => {
    for (const [src, f] of found) {
      if (f.failed) continue;
      db.prepare('DELETE FROM deal_review_evidence WHERE opportunity_id = ? AND provider = ? AND source_type = ? AND source_id = ?')
        .run(opp.id, provider, src.type, src.id);
      const segs = segmentSource(src);
      const modelSides = new Map(f.speakers.map(s => [nameKey(s.name), s.side]));
      const seen = new Set();
      let kept = 0;
      for (const p of f.picks) {
        const k = `${p.section}|${p.index}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const seg = segs[p.index];
        let side;
        if (src.type === 'note') side = 'note';
        else if (src.type === 'internal_call') side = 'internal';
        else side = (seg.speaker && (sideFromDirectory(seg.speaker, people) || modelSides.get(nameKey(seg.speaker)))) || 'unknown';
        const context = [neighbor(segs, p.index - 1), '▶', neighbor(segs, p.index + 1)].filter(Boolean).join(' ');
        insert.run(opp.id, opp.account_id, provider, src.type, src.id, src.label, src.date,
          p.section, seg.text, context === '▶' ? null : context, seg.speaker, side);
        kept++;
      }
      db.prepare(`
        INSERT INTO deal_review_source_runs (opportunity_id, provider, source_type, source_id, content_hash, model, proposed, verified, extracted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(opportunity_id, provider, source_type, source_id) DO UPDATE SET
          content_hash = excluded.content_hash, model = excluded.model, proposed = excluded.proposed,
          verified = excluded.verified, extracted_at = CURRENT_TIMESTAMP
      `).run(opp.id, provider, src.type, src.id, src.hash,
             provider === 'local' ? `local:${local.local_model}` : ANTHROPIC_MODEL, f.proposed, kept);
      proposed += f.proposed;
      verified += kept;
    }
  });
  write();
  return { read: todo.length, proposed, verified, errors };
}

// --- facts the notebook already holds -------------------------------------------------

const ROLE_LABEL = {
  decision_maker: 'Decision maker', champion: 'Champion', technical_lead: 'Technical lead',
  influencer: 'Influencer', procurement: 'Procurement'
};

function notebookFacts(opp, forecast) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(opp.account_id);
  const contacts = db.prepare(`
    SELECT c.name, c.title, COALESCE(c.contact_type, 'customer') AS type, ca.role
    FROM contacts c JOIN contact_accounts ca ON ca.contact_id = c.id WHERE ca.account_id = ?
  `).all(opp.account_id);
  const customers = contacts.filter(c => c.type === 'customer');
  const partners = db.prepare(`
    SELECT a.account_name FROM account_partners p JOIN accounts a ON a.id = p.partner_id WHERE p.account_id = ?
  `).all(opp.account_id).map(r => r.account_name);
  const steps = db.prepare(`
    SELECT text, owner FROM next_steps WHERE opportunity_id = ? AND completed = 0 ORDER BY created_at
  `).all(opp.id);
  const povs = db.prepare('SELECT status, generated_at FROM pov_drafts WHERE opportunity_id = ? AND deleted_at IS NULL ORDER BY generated_at DESC').all(opp.id);
  const priorWins = db.prepare(`SELECT name FROM opportunities WHERE account_id = ? AND id <> ? AND status = 'won'`).all(opp.account_id, opp.id);

  const roles = new Set(customers.map(c => c.role).filter(Boolean));
  const facts = [];
  const add = (text) => { facts.push({ id: `F${facts.length + 1}`, text }); return facts[facts.length - 1].id; };

  add(`Deal: ${account.account_name}${opp.name && opp.name !== account.account_name ? ` — ${opp.name}` : ''}; ` +
      `presales stage ${opp.presales_stage || 'not set'}; close date ${opp.close_date || 'not set'}; ` +
      `${opp.opportunity_value != null ? `value $${opp.opportunity_value}; ` : ''}industry ${account.industry || 'not set'}.`);
  add(customers.length
    ? `Customer contacts recorded (${customers.length}): ${customers.map(c => `${c.name}${c.title ? ` (${c.title})` : ''} — ${ROLE_LABEL[c.role] || 'no role set'}`).join('; ')}.` +
      `${roles.has('decision_maker') ? '' : ' No customer contact is marked as decision maker / economic buyer.'}` +
      `${roles.has('champion') ? '' : ' No customer contact is marked as champion.'}`
    : 'No customer contacts are recorded for this account.');
  add(partners.length ? `Partners linked to the deal: ${partners.join(', ')}.` : 'No partner is linked to this deal.');
  add(steps.length
    ? `Open next steps (${steps.length}): ${steps.slice(0, 10).map(s => `${s.text}${s.owner ? ` [${s.owner}]` : ''}`).join('; ')}.`
    : 'No open next steps are recorded for this deal.');
  add(povs.length
    ? `POV documents: ${povs.length} (latest status ${povs[0].status || 'draft'}). Success plan link ${account.pov_success_plan_url ? 'is' : 'is not'} recorded.`
    : `No POV document has been generated for this deal. Success plan link ${account.pov_success_plan_url ? 'is' : 'is not'} recorded.`);
  if (forecast) {
    const pushes = forecast.close_date_pushes || [];
    add(`Deal age ${forecast.age_days} days. Close-date changes are tracked since ${String(forecast.tracked_since || '').slice(0, 10) || 'recently'}: ` +
        `${pushes.length ? `${pushes.length} push(es), ${forecast.quarter_slips} into a later quarter` : 'no pushes recorded'}.`);
  }
  add(priorWins.length ? `Existing customer: earlier deals won (${priorWins.map(w => w.name).join(', ')}).` : 'Not recorded as an existing customer in this notebook.');

  return {
    facts,
    summary: {
      customerContacts: customers.length,
      hasDecisionMaker: roles.has('decision_maker'),
      hasChampion: roles.has('champion'),
      openSteps: steps.length,
      quarterSlips: forecast ? forecast.quarter_slips : 0,
      stepsFact: facts[3].id,
      contactsFact: facts[1].id,
      historyFact: forecast ? facts[5].id : null
    }
  };
}

// --- stage 2: answering ------------------------------------------------------------------

const SIDE_LABEL = {
  customer: 'CUSTOMER', opswat: 'OPSWAT', partner: 'PARTNER', note: 'SE NOTE',
  internal: 'INTERNAL CALL (team only)', unknown: 'SPEAKER UNKNOWN'
};

function renderEvidence(e, withContext) {
  const who = `${SIDE_LABEL[e.speaker_side] || 'SPEAKER UNKNOWN'}${e.speaker ? ` — ${e.speaker}` : ''}`;
  const where = `${e.source_type === 'note' ? 'note' : `"${e.source_label}"`} ${e.source_date || ''}`.trim();
  return `[E${e.id}] ${who} · ${where}\n"${e.excerpt}"${withContext && e.context ? `\n  context: ${e.context}` : ''}`;
}

function renderPack(evidence, withContext) {
  return SECTIONS.map(s => {
    const items = evidence.filter(e => e.section_key === s.key);
    if (!items.length) return null;
    return `## ${s.number}. ${s.title}\n${items.map(e => renderEvidence(e, withContext)).join('\n')}`;
  }).filter(Boolean).join('\n\n');
}

const ANSWER_INSTRUCTIONS = `You are helping an OPSWAT presales solutions engineer prepare a deal review. Answer the review questions using ONLY the evidence excerpts [E…] and notebook facts [F…] below. They were collected from the deal's notes, customer call transcripts and internal calls; nothing else is known.

Each excerpt is labeled with who said it: CUSTOMER, OPSWAT, PARTNER, SE NOTE (the solutions engineer's own notes), INTERNAL CALL (the OPSWAT team talking among themselves), or SPEAKER UNKNOWN.

For each question return:
- status:
  - "answered": the evidence clearly answers it. You must cite at least one excerpt or fact.
  - "partial": the evidence answers part of it, only from our side, or weakly. Prefer "partial" whenever you are unsure.
  - "unanswered": nothing bears on it.
  - "na": it doesn't apply to this deal (an OT-only question on an IT-only deal, a hardware question with no hardware, an existing-customer question for a new customer). Say why.
  - For RED FLAG items: "flagged" when the evidence shows the risk is present (absence counts when the question is about something missing, e.g. no economic buyer access); "clear" only when evidence positively shows it isn't; "unanswered" when you can't tell.
- answer: one to three plain sentences, specific (names, roles, numbers, dates). Do not quote; the citations carry the quotes.
- cites: the ids of the excerpts and facts that support the answer, e.g. ["E12", "F2"].

A list of open next steps is not a close plan or mutual action plan; only call it one if the evidence shows a plan agreed with the customer that runs to signature.

Be strict about people and roles. A technical lead, an evaluator or procurement is not the economic buyer. Only someone who controls the budget or signs is. If the notebook facts say no one is marked as decision maker and no excerpt shows who holds the budget, the economic buyer is unknown. Questions about what the customer said "in their own words", "unprompted" or "themselves" need an excerpt from a CUSTOMER speaker; our team describing it is not enough. Do not name any sales qualification framework or methodology in your answers.`;

const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['key', 'status', 'answer', 'cites'],
        properties: {
          key: { type: 'string' },
          status: { type: 'string', enum: ['answered', 'partial', 'unanswered', 'na', 'flagged', 'clear'] },
          answer: { type: 'string' },
          cites: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};

function questionsPrompt(section, askable, settled) {
  const describe = (q) => {
    const tags = [];
    if (q.headline) tags.push('headline question');
    if (section.killer && !q.headline) tags.push('RED FLAG');
    if (q.customerVoice) tags.push('needs the customer’s own words');
    if (q.applies) tags.push(`only applies to: ${APPLIES_LABEL[q.applies]}`);
    return `- ${q.key}${tags.length ? ` [${tags.join('; ')}]` : ''}: ${q.text}`;
  };
  const parts = [`Section ${section.number}: ${section.title}`, '', 'Questions to answer:', ...askable.map(describe)];
  if (settled.length) {
    parts.push('', 'Already settled by the SE (context only, do not answer):');
    for (const { q, a } of settled) parts.push(`- ${q.text} → ${a.status}${a.answer ? `: ${a.answer}` : ''}`);
  }
  return parts.join('\n');
}

// Quoted phrases in an answer must be real. Models like to wrap a paraphrase
// in quote marks; anything quoted that isn't in the cited excerpts loses its
// quote marks, so the answer can't pass a paraphrase off as the customer's
// words.
const looseNorm = (t) => String(t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

function unquoteParaphrases(answer, citedTexts) {
  const hay = looseNorm(citedTexts.join(' '));
  // A quote mark only counts at a word boundary, so apostrophes ("isn't",
  // "customer's") are never mistaken for quotes.
  return answer.replace(/(^|[\s(:])(["\u201c'\u2018])([^"\u201d\n]{25,}?)(["\u201d'\u2019])(?=[\s.,;:!?)]|$)/g,
    (whole, before, open, inner) => {
      const needle = looseNorm(inner.replace(/\.\.\.|\u2026/g, ' '));
      return needle.split(' ').length > 4 && hay.includes(needle) ? whole : `${before}${inner}`;
    });
}

// --- the run --------------------------------------------------------------------------------

async function fillDealReviewFromEvidence({ key, opp, forecast }) {
  const started = Date.now();
  const provider = llm.providerFor('deal_review');
  const local = provider === 'local' ? llm.read() : null;
  const modelLabel = local ? `local:${local.local_model}` : ANTHROPIC_MODEL;

  const sources = loadSources(opp);
  if (!sources.length) {
    const e = new Error('This deal has no notes, transcripts or internal calls to read yet.');
    e.status = 400;
    throw e;
  }
  const people = peopleDirectory(opp);

  setProgress(opp.id, { stage: 'reading', done: 0, total: null });
  try {
    return await runStages({ key, opp, forecast, started, provider, local, modelLabel, sources, people });
  } finally {
    progress.delete(opp.id);
  }
}

async function runStages({ key, opp, forecast, started, provider, local, modelLabel, sources, people }) {
  // Stage 1.
  const read = await readSources({
    opp, provider, key, local, sources, people,
    onBatch: (done, total) => setProgress(opp.id, { stage: 'reading', done, total })
  });

  // Stage 2 inputs.
  const evidence = db.prepare(`
    SELECT * FROM deal_review_evidence WHERE opportunity_id = ? AND provider = ? ORDER BY source_date, id
  `).all(opp.id, provider);
  const evidenceById = new Map(evidence.map(e => [`E${e.id}`, e]));
  const { facts, summary } = notebookFacts(opp, forecast);
  const factIds = new Set(facts.map(f => f.id));
  const factsText = facts.map(f => `[${f.id}] ${f.text}`).join('\n');

  const existing = {};
  for (const row of db.prepare('SELECT * FROM deal_review_answers WHERE opportunity_id = ?').all(opp.id)) existing[row.question_key] = row;

  const jobs = SECTIONS.map(section => {
    const askable = [];
    const settled = [];
    for (const q of section.questions) {
      const a = existing[q.key];
      if (a && a.locked) settled.push({ q, a });
      else if (!q.manual && !q.computed) askable.push(q);
    }
    return { section, askable, settled };
  }).filter(j => j.askable.length);

  // The whole evidence pack goes in the (shared, cacheable) system prompt when
  // it fits; otherwise each section gets its own evidence in full and the rest
  // as bare excerpts, newest first, as far as the budget allows.
  const budgetChars = local
    ? Math.max(4000, (local.local_context_tokens - llm.estimateTokens(ANSWER_INSTRUCTIONS) - llm.estimateTokens(factsText) - 1500 - ANSWER_OUTPUT_TOKENS) * CHARS_PER_TOKEN)
    : 600000;
  let sharedPack = renderPack(evidence, true);
  if (sharedPack.length > budgetChars) sharedPack = renderPack(evidence, false);
  const shared = sharedPack.length <= budgetChars;
  let excerptsLeftOut = 0;

  const perSectionPack = (sectionKey) => {
    const mine = evidence.filter(e => e.section_key === sectionKey);
    const others = evidence.filter(e => e.section_key !== sectionKey).reverse();
    const lines = [];
    let used = 0;
    for (const e of [...mine].reverse()) {
      const t = renderEvidence(e, true);
      if (used + t.length > budgetChars) { excerptsLeftOut++; continue; }
      lines.unshift(t); used += t.length;
    }
    const extra = [];
    for (const e of others) {
      const t = renderEvidence(e, false);
      if (used + t.length > budgetChars) break;
      extra.push(t); used += t.length;
    }
    return `Evidence for this section:\n${lines.join('\n') || '(none)'}${extra.length ? `\n\nOther evidence from the deal:\n${extra.join('\n')}` : ''}`;
  };

  const systemFor = () => `${ANSWER_INSTRUCTIONS}\n\nNotebook facts:\n${factsText}${shared ? `\n\nEvidence excerpts:\n${sharedPack || '(none found)'}` : ''}`;

  setProgress(opp.id, { stage: 'answering', done: 0, total: jobs.length });
  const errors = [...read.errors.map(e => ({ section: `Reading ${e.source}`, error: e.error }))];
  let answered = 0;
  const run = async (job) => {
    try {
      const soFar = job.soFar && job.soFar.length
        ? `The rest of this review was answered as follows. Stay consistent with it unless the evidence clearly says otherwise:\n${job.soFar.join('\n')}\n\n`
        : '';
      const user = `${shared ? '' : `${perSectionPack(job.section.key)}\n\n`}${soFar}${questionsPrompt(job.section, job.askable, job.settled)}`;
      const { parsed } = await askJson({
        provider, key, local, system: systemFor(), user,
        schema: ANSWER_SCHEMA, name: 'deal_review_answer', maxTokens: ANSWER_OUTPUT_TOKENS
      });
      return { job, answers: (parsed && parsed.answers) || [] };
    } catch (e) {
      errors.push({ section: job.section.title, error: e.message });
      return { job, answers: [] };
    } finally {
      answered++;
      setProgress(opp.id, { stage: 'answering', done: answered, total: jobs.length });
    }
  };
  // The Deal Killer checklist goes last and sees every other section's
  // answers, so a flag can't contradict what the rest of the review says.
  const killerJob = jobs.find(j => j.section.killer);
  const firstJobs = jobs.filter(j => j !== killerJob);
  const results = provider === 'local'
    ? await inBatches(firstJobs, 1, run)
    : [await run(firstJobs[0]), ...await inBatches(firstJobs.slice(1), ANTHROPIC_PARALLEL, run)];
  if (killerJob) {
    const soFar = results.flatMap(r => r.answers
      .filter(a => a.status && a.status !== 'unanswered' && BY_KEY.has(a.key))
      .map(a => `- ${BY_KEY.get(a.key).text} → ${a.status}: ${String(a.answer || '').slice(0, 220)}`));
    killerJob.soFar = soFar;
    results.push(await run(killerJob));
  }

  // Rules, then write.
  const stats = { written: 0, unanswered: 0, downgraded: 0, from_records: 0 };
  const upsert = db.prepare(`
    INSERT INTO deal_review_answers (
      opportunity_id, account_id, question_key, status, answer, evidence,
      source_type, source_id, source_label, source_date, voice, locked, updated_by, ai_model, evidence_ids, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ai', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(opportunity_id, question_key) DO UPDATE SET
      status = excluded.status, answer = excluded.answer, evidence = excluded.evidence,
      source_type = excluded.source_type, source_id = excluded.source_id,
      source_label = excluded.source_label, source_date = excluded.source_date,
      voice = excluded.voice, updated_by = 'ai', ai_model = excluded.ai_model,
      evidence_ids = excluded.evidence_ids, updated_at = CURRENT_TIMESTAMP
    WHERE deal_review_answers.locked = 0
  `);

  const writeAnswer = (q, status, answer, cites, model = modelLabel) => {
    const ev = cites.filter(c => evidenceById.has(c)).map(c => evidenceById.get(c));
    const customerEv = ev.filter(e => e.speaker_side === 'customer');
    const ourEv = ev.filter(e => ['opswat', 'partner', 'note', 'internal'].includes(e.speaker_side));
    const voice = customerEv.length ? 'customer'
      : ourEv.length ? 'team'
      : cites.some(c => factIds.has(c)) && !ev.length ? 'app'
      : 'inferred';
    const shown = customerEv[0] || ev[0] || null;
    upsert.run(
      opp.id, opp.account_id, q.key, status, answer || null, shown ? shown.excerpt : null,
      shown ? shown.source_type : (voice === 'app' ? 'app' : null), shown ? shown.source_id : null,
      shown ? (shown.speaker ? `${shown.speaker} · ${shown.source_type === 'note' ? 'Note' : shown.source_label}` : shown.source_label) : (voice === 'app' ? 'Notebook records' : null),
      shown ? shown.source_date : null, voice, model, JSON.stringify(cites)
    );
    stats.written++;
  };

  const write = db.transaction(() => {
    for (const { job, answers } of results) {
      const askableKeys = new Set(job.askable.map(q => q.key));
      for (const a of answers) {
        const q = BY_KEY.get(a.key);
        if (!q || !askableKeys.has(a.key)) continue;
        const killer = job.section.killer && !q.headline;
        let status = a.status;
        const valid = killer ? ['flagged', 'clear', 'unanswered', 'na'] : ['answered', 'partial', 'unanswered', 'na'];
        if (!valid.includes(status)) continue;
        const cites = [...new Set((a.cites || []).map(String).map(s => s.trim()).filter(c => evidenceById.has(c) || factIds.has(c)))];
        let answer = unquoteParaphrases(String(a.answer || '').trim(),
          cites.filter(c => evidenceById.has(c)).map(c => evidenceById.get(c).excerpt));

        if (status === 'unanswered') { stats.unanswered++; continue; }
        if (killer && status === 'clear' && !cites.length) { stats.downgraded++; stats.unanswered++; continue; }
        if (status === 'answered' && !cites.length) { status = 'partial'; stats.downgraded++; }
        if (status === 'answered' && q.customerVoice &&
            !cites.some(c => evidenceById.has(c) && evidenceById.get(c).speaker_side === 'customer')) {
          status = 'partial';
          stats.downgraded++;
          answer = `${answer}${answer ? ' ' : ''}(Not yet confirmed in the customer’s own words.)`;
        }
        writeAnswer(q, status, answer, cites);
      }
    }

    // Straight from the notebook's records, whatever the model said. Only
    // ever raises a flag; the absence of a record never clears one.
    const fromRecords = (key, text, cite) => {
      const q = BY_KEY.get(key);
      if (!q || (existing[key] && existing[key].locked)) return;
      writeAnswer(q, 'flagged', text, cite ? [cite] : [], 'app');
      stats.from_records++;
    };
    if (summary.customerContacts <= 1) {
      fromRecords('deal_killers.5', summary.customerContacts
        ? 'Only one customer contact is recorded for this account, so the deal rests on a single relationship.'
        : 'No customer contacts are recorded for this account.', summary.contactsFact);
    }
    if (summary.openSteps === 0) {
      fromRecords('deal_killers.6', 'No open next steps are recorded for this deal.', summary.stepsFact);
    }
    if (summary.quarterSlips >= 2) {
      fromRecords('deal_killers.8', `The close date has moved into a later quarter ${summary.quarterSlips} times since tracking began.`, summary.historyFact);
    }
  });
  write();

  const omitted = excerptsLeftOut;
  db.prepare(`
    INSERT INTO deal_review_runs (opportunity_id, provider, model, method, ms, answers_written, sources_read, sources_omitted,
      excerpts_proposed, excerpts_verified, downgraded, errors)
    VALUES (?, ?, ?, 'evidence', ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(opp.id, provider, modelLabel, Date.now() - started, stats.written, read.read, read.proposed, read.verified, stats.downgraded, errors.length);

  return {
    method: 'evidence',
    provider,
    model: modelLabel,
    ms: Date.now() - started,
    sources_total: sources.length,
    sources_read: read.read,
    excerpts_proposed: read.proposed,
    excerpts_verified: read.verified,
    excerpts_total: evidence.length,
    excerpts_left_out: omitted,
    ...stats,
    needs_roles: !summary.hasDecisionMaker || !summary.hasChampion,
    errors
  };
}

// The evidence an answer cites, for the tab's "show excerpts".
function evidenceFor(opportunityId, ids) {
  const nums = ids.filter(i => /^E\d+$/.test(i)).map(i => Number(i.slice(1)));
  if (!nums.length) return [];
  return db.prepare(`SELECT id, excerpt, speaker, speaker_side, source_type, source_label, source_date FROM deal_review_evidence
    WHERE opportunity_id = ? AND id IN (${nums.map(() => '?').join(',')})`).all(opportunityId, ...nums);
}

module.exports = { fillDealReviewFromEvidence, getProgress, evidenceFor, notebookFacts };

// For tests only.
module.exports._test = { batchPrompt, READ_SYSTEM, READ_SCHEMA, segmentSource, readBatches };
module.exports._test.unquoteParaphrases = unquoteParaphrases;
