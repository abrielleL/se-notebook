// The deal review's AI fill: read one opportunity's notes, customer
// transcripts and internal calls, and answer the review's questions with a
// short answer, a verbatim supporting quote, and whose words it rests on.
//
// Shape of the run:
//   - The material is assembled once into a single "corpus" block and sent as
//     a cached system block, so the one-call-per-section fan-out pays for it
//     roughly once. The first section runs alone to write the cache; the rest
//     then run in parallel and read it.
//   - Every request uses the same system prompt, schema and effort, because
//     any difference there would miss the cache.
//   - Quotes are checked against the source text. A quote the model can't be
//     shown to have copied is dropped rather than shown as if it were real.
//   - Locked answers (edited by hand) are never written; they go to the model
//     as settled context instead.

const db = require('../db/database');
const { callAnthropicMessage } = require('./anthropic');
const { SECTIONS, BY_KEY, APPLIES_LABEL } = require('./dealReviewQuestions');

const MODEL = 'claude-opus-5-5';
const EFFORT = 'medium';
// Roughly 150k tokens of material. Opus 5.5 takes far more, but this is
// re-read once per section; past this the oldest calls are left out, and the
// run reports exactly which ones.
const CORPUS_CHAR_BUDGET = 600000;
const PARALLEL = 4;

const SYSTEM_PROMPT = `You are helping an OPSWAT presales solutions engineer prepare a deal review. OPSWAT sells cybersecurity products for critical infrastructure and enterprise IT: MetaDefender (multiscanning, Deep CDR, sandboxing), MetaDefender Kiosk and other removable-media controls, Managed File Transfer, the Unidirectional and Bilateral Security Gateways (data diodes), DLP, and OT/ICS security.

You will be given the deal's source material and, in each request, one section of the review's questions. Answer each question using only the source material.

For each question return:
- status:
  - "answered": the material clearly answers the question.
  - "partial": the material answers part of it, answers it only from one side, or the answer is weak or unconfirmed.
  - "unanswered": nothing in the material bears on it. Leave answer, quote and source empty.
  - "na": the question does not apply to this deal, e.g. an OT-only question on a pure IT deal, a hardware question with no hardware involved, or an existing-customer question for a new customer. Say why in the answer.
  - For red-flag items (marked RED FLAG), use "flagged" when the material shows the risk is present, "clear" only when the material positively shows it is not, and "unanswered" when you can't tell. Never mark a flag clear for lack of evidence.
- answer: one to three plain sentences. Be specific: names, roles, numbers, dates, products. Where a question asks whether the customer said something themselves, answer that directly, and if only our side has said it, say so.
- quote: a short excerpt (at most about 40 words) copied exactly, character for character, from ONE source that best supports the answer. Do not fix spelling, merge passages or paraphrase. Empty if no single passage supports it.
- source: the id of the source the quote came from, e.g. "T3". Empty if there is no quote.
- voice: whose words the answer rests on:
  - "customer": a customer person said it, in a customer call or as recorded in a note.
  - "team": the OPSWAT or partner team's own read. Anything from an internal call is "team", even when it reports what the customer said.
  - "inferred": you deduced it; nobody stated it.
  - "none": for unanswered questions.

Internal calls are conversations between the AE, the SE and colleagues about the deal. They can help answer questions, but they are our team's view, not the customer's words.

Questions listed as already settled by the SE are context only: use them, don't answer them.

Return exactly one entry for each question listed under "Questions to answer", using its key. Do not name any sales qualification framework or methodology in your answers.`;

// One schema for every section, so that the request prefix stays identical
// and the corpus cache is reused. The keys are validated after parsing.
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'status', 'answer', 'quote', 'source', 'voice'],
        properties: {
          key: { type: 'string' },
          status: { type: 'string', enum: ['answered', 'partial', 'unanswered', 'na', 'flagged', 'clear'] },
          answer: { type: 'string' },
          quote: { type: 'string' },
          source: { type: 'string' },
          voice: { type: 'string', enum: ['customer', 'team', 'inferred', 'none'] }
        }
      }
    }
  }
};

const KILLER_STATUSES = new Set(['flagged', 'clear', 'unanswered', 'na']);
const QUESTION_STATUSES = new Set(['answered', 'partial', 'unanswered', 'na']);

// --- material ---------------------------------------------------------------

function loadSources(opp) {
  const notes = db.prepare(`
    SELECT id, date, raw_notes FROM notes
    WHERE opportunity_id = ? AND deleted_at IS NULL AND raw_notes IS NOT NULL AND trim(raw_notes) <> ''
    ORDER BY date, created_at
  `).all(opp.id);
  const transcripts = db.prepare(`
    SELECT id, title, call_date, created_at, content FROM transcripts
    WHERE opportunity_id = ? ORDER BY COALESCE(call_date, created_at), created_at
  `).all(opp.id);
  const internal = db.prepare(`
    SELECT id, title, call_date, created_at, content FROM internal_calls
    WHERE opportunity_id = ? ORDER BY COALESCE(call_date, created_at), created_at
  `).all(opp.id);

  const sources = [];
  notes.forEach((n, i) => sources.push({
    sid: `N${i + 1}`, type: 'note', id: n.id, date: n.date,
    label: `Note`, kind: 'SE note', content: n.raw_notes
  }));
  transcripts.forEach((t, i) => sources.push({
    sid: `T${i + 1}`, type: 'transcript', id: t.id, date: t.call_date || (t.created_at || '').slice(0, 10),
    label: t.title || 'Transcript', kind: 'customer call transcript', content: t.content
  }));
  internal.forEach((c, i) => sources.push({
    sid: `I${i + 1}`, type: 'internal_call', id: c.id, date: c.call_date || (c.created_at || '').slice(0, 10),
    label: c.title || 'Internal call', kind: 'internal call (our team only)', content: c.content
  }));
  return sources;
}

// Keep everything that fits, newest first. Notes are short and always fit in
// practice; the long items that get dropped are the oldest calls, whose
// substance has usually been repeated in later ones.
function fitToBudget(sources) {
  const byNewest = [...sources].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  let used = 0;
  const kept = new Set();
  const omitted = [];
  for (const s of byNewest) {
    const len = (s.content || '').length + 200;
    if (used + len <= CORPUS_CHAR_BUDGET) { kept.add(s); used += len; }
    else omitted.push(s);
  }
  return { kept: sources.filter(s => kept.has(s)), omitted };
}

function accountHeader(opp) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(opp.account_id);
  const partners = db.prepare(`
    SELECT a.account_name FROM account_partners p JOIN accounts a ON a.id = p.partner_id
    WHERE p.account_id = ?
  `).all(opp.account_id).map(r => r.account_name);
  const priorWins = db.prepare(`
    SELECT name FROM opportunities WHERE account_id = ? AND id <> ? AND status = 'won'
  `).all(opp.account_id, opp.id).map(r => r.name);

  const lines = [
    `Account: ${account.account_name}`,
    account.industry && `Industry: ${account.industry}`,
    `Opportunity: ${opp.name}`,
    opp.presales_stage && `Presales stage: ${opp.presales_stage}`,
    opp.close_date && `Expected close date: ${opp.close_date}`,
    opp.opportunity_value != null && `Value: $${opp.opportunity_value}`,
    partners.length && `Partners on the deal: ${partners.join(', ')}`,
    `Existing customer: ${priorWins.length ? `yes (previous deals won: ${priorWins.join(', ')})` : 'not recorded as one in this notebook'}`,
    account.ai_environment && `Customer environment (summarized from earlier material):\n${account.ai_environment}`
  ].filter(Boolean);
  return lines.join('\n');
}

function corpusText(opp, sources) {
  const blocks = sources.map(s =>
    `<source id="${s.sid}" type="${s.kind}" date="${s.date || 'unknown'}"${s.type !== 'note' ? ` title="${String(s.label).replace(/"/g, "'")}"` : ''}>\n${s.content}\n</source>`
  );
  return `<deal>\n${accountHeader(opp)}\n</deal>\n\n<sources>\n${blocks.join('\n\n')}\n</sources>`;
}

// --- per-section request ----------------------------------------------------

function sectionPrompt(section, askable, settled) {
  const describe = (q) => {
    const tags = [];
    if (q.headline) tags.push('headline question');
    if (section.killer && !q.headline) tags.push('RED FLAG');
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

async function askSection({ key, corpus, section, askable, settled }) {
  const msg = await callAnthropicMessage({
    key,
    model: MODEL,
    max_tokens: 16000,
    system: [
      { type: 'text', text: SYSTEM_PROMPT },
      { type: 'text', text: corpus, cache_control: { type: 'ephemeral' } }
    ],
    messages: [{ role: 'user', content: sectionPrompt(section, askable, settled) }],
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } }
  });
  return { parsed: JSON.parse(msg.text), usage: msg.usage || {} };
}

// --- quote checking -----------------------------------------------------------

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[‘’‚‛]/g, "'")
  .replace(/[“”„‟]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

// Find which source a quote really came from: the cited one first, then any.
// Leading/trailing quote marks and ellipses are trimmed before matching.
function locateQuote(quote, citedSid, sources, normCache) {
  const q = norm(quote).replace(/^["'.…\s]+|["'.…\s]+$/g, '');
  if (q.length < 8) return null;
  const cited = sources.find(s => s.sid === citedSid);
  const ordered = cited ? [cited, ...sources.filter(s => s !== cited)] : sources;
  for (const s of ordered) {
    if (!normCache.has(s)) normCache.set(s, norm(s.content));
    if (normCache.get(s).includes(q)) return s;
  }
  return null;
}

// --- the run ------------------------------------------------------------------

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

async function fillDealReview({ key, opp }) {
  const all = loadSources(opp);
  if (!all.length) {
    const e = new Error('This deal has no notes, transcripts or internal calls to read yet.');
    e.status = 400;
    throw e;
  }
  const { kept: sources, omitted } = fitToBudget(all);
  const corpus = corpusText(opp, sources);

  const existing = {};
  for (const row of db.prepare('SELECT * FROM deal_review_answers WHERE opportunity_id = ?').all(opp.id)) {
    existing[row.question_key] = row;
  }

  // What each section asks: everything except locked answers and the
  // questions no text can answer (manual or computed from the app's data).
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

  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const errors = [];
  const run = async (job) => {
    try {
      const r = await askSection({ key, corpus, ...job });
      for (const k of Object.keys(usage)) usage[k] += r.usage[k] || 0;
      return { job, answers: (r.parsed && r.parsed.answers) || [] };
    } catch (e) {
      // A section that fails just stays as it was; the run reports it.
      errors.push({ section: job.section.title, error: e.message });
      return { job, answers: [] };
    }
  };

  // The first call writes the cache; running the rest alongside it would have
  // each of them pay for the whole corpus.
  const [first, ...rest] = jobs;
  const results = [await run(first)];
  // If the first call failed (bad key, rejected request, outage), the rest
  // would fail the same way; stop and say why instead of failing twelve times.
  if (errors.length) {
    const e = new Error(errors[0].error);
    e.status = /API key|error 40[13]/.test(errors[0].error) ? 400 : 502;
    throw e;
  }
  results.push(...await inBatches(rest, PARALLEL, run));

  const upsert = db.prepare(`
    INSERT INTO deal_review_answers (
      opportunity_id, account_id, question_key, status, answer, evidence,
      source_type, source_id, source_label, source_date, voice, locked, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ai', CURRENT_TIMESTAMP)
    ON CONFLICT(opportunity_id, question_key) DO UPDATE SET
      status = excluded.status, answer = excluded.answer, evidence = excluded.evidence,
      source_type = excluded.source_type, source_id = excluded.source_id,
      source_label = excluded.source_label, source_date = excluded.source_date,
      voice = excluded.voice, updated_by = 'ai', updated_at = CURRENT_TIMESTAMP
    WHERE deal_review_answers.locked = 0
  `);

  const normCache = new Map();
  const stats = { written: 0, unanswered: 0, quotes_kept: 0, quotes_dropped: 0 };
  const write = db.transaction(() => {
    for (const { job, answers } of results) {
      const askableKeys = new Set(job.askable.map(q => q.key));
      for (const a of answers) {
        const q = BY_KEY.get(a.key);
        if (!q || !askableKeys.has(a.key)) continue;
        const killer = job.section.killer && !q.headline;
        if (!(killer ? KILLER_STATUSES : QUESTION_STATUSES).has(a.status)) continue;
        // "Nothing found" never erases an answer an earlier run did find.
        if (a.status === 'unanswered') { stats.unanswered++; continue; }

        let source = null;
        // Stored bare; the tab adds its own quote marks.
        let quote = (a.quote || '').trim().replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '').trim() || null;
        if (quote) {
          source = locateQuote(quote, a.source, sources, normCache);
          if (source) stats.quotes_kept++;
          else { stats.quotes_dropped++; quote = null; }
        }
        if (!source && a.source) source = sources.find(s => s.sid === a.source) || null;

        let voice = a.voice === 'none' ? null : a.voice;
        // An internal call is our team talking, whatever it reports.
        if (voice === 'customer' && source && source.type === 'internal_call') voice = 'team';
        // Without a verified quote there's nothing showing the customer said it.
        if (voice === 'customer' && !quote) voice = 'inferred';

        upsert.run(
          opp.id, opp.account_id, q.key, a.status, (a.answer || '').trim() || null, quote,
          source ? source.type : null, source ? source.id : null,
          source ? source.label : null, source ? source.date : null, voice
        );
        stats.written++;
      }
    }
  });
  write();

  return {
    sections_run: jobs.length,
    ...stats,
    sources_read: sources.length,
    sources_omitted: omitted.map(s => ({ type: s.type, label: s.label, date: s.date })),
    errors,
    usage,
    model: MODEL
  };
}

module.exports = { fillDealReview };
