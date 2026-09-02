import { api } from './api.js';

export const ANTHROPIC_KEY_STORAGE = 'anthropic_api_key';
export const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export function getApiKey() {
  return localStorage.getItem(ANTHROPIC_KEY_STORAGE) || '';
}

export function hasApiKey() {
  return Boolean(getApiKey());
}

// Stage-aware CRM snapshot guidance. Keyed to Sugar CRM presales stages.
// Natural language only — no field-label prefixes anywhere.
// Stage-aware emphasis. Every stage still leads with the current technical-
// validation status and ends with the next step — the stage only shifts what
// "validation status" means at that point in the evaluation.
function snapshotInstruction(stage) {
  switch (stage) {
    case '1-Discovery':
      return 'Validation status: which technical drivers/use cases are confirmed and any environment constraints uncovered. Next step: what advances this to a demo.';
    case '2-Demo':
      return 'Validation status: what the demo proved out and the technical gaps or open questions still open. Next step: what advances toward a POV plan.';
    case '3-Workshop':
    case '4-Planning':
      return 'Validation status: POV success-criteria and prerequisite/environment readiness. Next step: the target kickoff.';
    case '5-Deployment':
      return 'Validation status: install/config progress and any blockers standing up the evaluation. Next step: what starts testing.';
    case '6-In Progress':
      return 'Validation status: success criteria met (X of Y) and active technical risks or blockers. Next step: the immediate next action.';
    case '7-Technical Win':
      return 'Validation status: the technical validation that was achieved and the differentiator that proved it. Next step: the commercial next step.';
    case '8-Technical Loss':
      return 'Validation status: what failed validation and the technical gap or competitor that won. Next step: any remaining action.';
    case 'Stalled':
      return 'Validation status: where technical validation stood when activity paused and what caused the stall. Next step: what would re-engage.';
    default:
      return 'Validation status: current state of technical validation and any risk to technical fit or timing. Next step: the immediate next action.';
  }
}

function buildSnapshotSystemPrompt(stage) {
  return `You are a solutions engineering assistant. From the account notes and transcripts below, write a CRM status update for the SE notes field on the opportunity. It must read as a concise technical-validation status followed by the next step — nothing else.

${snapshotInstruction(stage)}

Rules:
- 255 characters is a HARD CEILING. Aim for roughly 200–245 so you have room to finish cleanly.
- Always end with a complete sentence and a period. Never trail off mid-thought — if you are running long, tighten earlier wording rather than getting cut off.
- Cover only (a) the current status of technical validation and (b) the next step(s). Cut business background, recaps, and filler.
- Do NOT include the account/company name or the word "MetaDefender" — the CRM record already carries that context. Specific product or module names (e.g. Core, ICAP, Kiosk, Sandbox) are fine when they matter.
- Plain prose. No bullet points, no markdown, no line breaks, and no field labels or prefixes (no "Status:", "Next:", "Risk:", etc.).
- End with the concrete next step.
- Return only the snapshot text, nothing else.`;
}

// Defensive cleanup: strip the account name and "MetaDefender" if the model
// slips them in, and normalize whitespace. Does NOT truncate.
function tidySnapshot(text, accountName) {
  let t = String(text || '').replace(/\s*\n+\s*/g, ' ').trim();
  t = t.replace(/\bMetaDefender\s*/gi, '');
  if (accountName) {
    const esc = accountName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (esc) t = t.replace(new RegExp(`\\b${esc}\\b('?s)?`, 'gi'), '');
  }
  return t.replace(/\s{2,}/g, ' ').replace(/^[\s,;:.\-–]+/, '').trim();
}

// True when the text reads as a finished thought (ends on sentence punctuation).
const endsComplete = (t) => /[.!?]["')\]]?$/.test((t || '').trim());

// Last-resort trim that keeps a COMPLETE sentence: cut at the last sentence
// terminator that fits; only fall back to a word boundary if there is none.
function trimToSentence(text, max) {
  let t = String(text || '').trim();
  if (t.length <= max && endsComplete(t)) return t;
  const slice = t.slice(0, max);
  const cut = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('!'), slice.lastIndexOf('?'));
  if (cut >= 60) return slice.slice(0, cut + 1).trim();
  const sp = slice.lastIndexOf(' ');
  return (sp > 0 ? slice.slice(0, sp) : slice).replace(/[\s,;:–-]+$/, '').trim();
}

// Ask the model to rewrite an over-long/cut-off note into a complete, in-budget one.
async function compressSnapshot(text) {
  const system = `Rewrite this CRM note to AT MOST 240 characters. Keep the technical-validation status and the next step. It MUST end with a complete sentence and a period — never trail off. Plain prose, no labels, and do not include any account name or the word "MetaDefender". Return only the rewritten note.`;
  return generateText({ system, user: text, maxTokens: 256 });
}

// The next-steps half of this contract is a reconciliation, not an append.
//
// Extraction used to only ever ADD steps, de-duplicated by exact text. Because
// it re-reads the whole corpus each run, it re-proposed the same actions in
// slightly different words every time and the exact-text check never caught
// them, so accounts accumulated dozens of copies of the same handful of items
// (one account reached 44 open steps, mostly six actions restated six ways).
// It also never noticed when a later note showed a step had been carried out.
//
// So the model is handed the currently-open steps under short handles and asked
// to sort them into: still open (say nothing), done, or a reworded duplicate of
// another — and to propose only genuinely new work.
const SYSTEM_PROMPT = `You are a solutions engineering assistant. Analyze the following account notes and call transcripts. Extract and return a JSON object with exactly these fields:
{
  "summary": "concise bullet-point summary covering deal status, key stakeholder, competitive risk, blockers, and momentum",
  "technical_drivers": "bullet list of key technical requirements and drivers",
  "environment": "description of current technical environment and architecture",
  "next_steps": ["array", "of", "NEW action items as strings"],
  "completed_steps": [{ "id": "s1", "evidence": "the note text that shows it was done" }],
  "duplicate_steps": [{ "id": "s2", "duplicate_of": "s1" }]
}

RECONCILING NEXT STEPS — read the "Currently open next steps" list below, if present:
- "completed_steps": open steps the notes or transcripts show have since been carried out. Quote the specific evidence. Be conservative: only when the notes actually show it happened, not when it merely seems likely or overdue.
- "duplicate_steps": open steps that restate another open step in different words. Point "duplicate_of" at the id of the one worth keeping (prefer the clearest, most specific wording). Only for genuinely the same action.
- "next_steps": action items NOT already on that list. Do not restate an open step in new words — if the work is already listed, leave it out entirely, even if you would phrase it better.
- Leave anything you are unsure about alone: omit it from all three and it stays open.

Be concise and technical. In summary, technical_drivers, and environment, use simple '- ' bullet points, one per line. Do not use bold ('**'), italic ('*'), headings ('#'), or tables. Return only valid JSON, no other text.`;

// Open steps, numbered s1..sN, plus the handle->real-id map. Short handles
// rather than UUIDs: cheaper in tokens and far less prone to the model
// inventing or mangling an identifier.
function openStepHandles(account) {
  const open = (account.next_steps || []).filter(s => !s.completed);
  const byHandle = new Map();
  open.forEach((s, i) => byHandle.set(`s${i + 1}`, s));
  return { open, byHandle };
}

function renderOpenSteps(byHandle) {
  if (!byHandle.size) return '';
  const lines = [...byHandle.entries()].map(([h, s]) => `${h}: ${s.text}`);
  return `\n\n## Currently open next steps\n${lines.join('\n')}`;
}

// Apply the model's reconciliation. Returns what actually changed so the
// caller can report it instead of silently rewriting someone's list.
async function applyStepReconciliation(accountId, byHandle, parsed) {
  const resolve = (h) => byHandle.get(String(h || '').trim());
  const closed = [];

  // Completed: the notes show the work happened.
  for (const entry of asArray(parsed.completed_steps)) {
    const step = resolve(entry && entry.id);
    if (!step || step.completed) continue;
    await api.updateNextStep(step.id, {
      completed: 1,
      resolved_reason: 'done',
      resolved_note: String((entry && entry.evidence) || '').slice(0, 500) || null
    });
    closed.push({ text: step.text, reason: 'done' });
  }

  // Duplicates: a reworded restatement of another open step. Guard against the
  // three ways this could quietly destroy real work — a step duplicating
  // itself, a step that's also named as the survivor of another pair (closing
  // both directions would drop the action entirely), and one already closed
  // above as done.
  const alreadyClosed = new Set(
    asArray(parsed.completed_steps).map(e => resolve(e && e.id)).filter(Boolean).map(s => s.id)
  );
  const survivors = new Set(
    asArray(parsed.duplicate_steps).map(e => resolve(e && e.duplicate_of)).filter(Boolean).map(s => s.id)
  );
  for (const entry of asArray(parsed.duplicate_steps)) {
    const step = resolve(entry && entry.id);
    const keep = resolve(entry && entry.duplicate_of);
    if (!step || !keep || step.id === keep.id) continue;
    if (step.completed || alreadyClosed.has(step.id) || survivors.has(step.id)) continue;
    await api.updateNextStep(step.id, {
      completed: 1,
      resolved_reason: 'duplicate',
      resolved_note: `Merged into: ${keep.text}`.slice(0, 500)
    });
    closed.push({ text: step.text, reason: 'duplicate' });
  }

  return closed;
}

function asArray(v) { return Array.isArray(v) ? v : []; }

function buildCorpus(account) {
  const noteBlocks = (account.notes || []).map(n =>
    `## Note — ${n.date}\n${n.raw_notes || ''}`
  );
  const transcriptBlocks = (account.transcripts || []).map(t =>
    `## Transcript — ${t.title || 'Untitled'} (${t.call_date || ''})\n${t.content || ''}`
  );
  return [`# Account: ${account.account_name}`, ...noteBlocks, ...transcriptBlocks].join('\n\n');
}

function extractJson(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = trimmed.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error('Failed to parse JSON from AI response');
}

export async function runAIExtraction(accountId) {
  const key = getApiKey();
  if (!key) throw new Error('Anthropic API key not set. Add it in Settings.');

  const account = await api.getAccount(accountId);
  const corpus = buildCorpus(account);
  if (!corpus.trim()) {
    throw new Error('No notes or transcripts to analyze yet.');
  }
  // The open steps travel with the corpus so the model can reconcile against
  // them rather than re-proposing work that's already recorded.
  const stepHandles = openStepHandles(account);

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: corpus + renderOpenSteps(stepHandles.byHandle) }]
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const json = await res.json();
  const text = (json.content || []).map(b => b.text || '').join('').trim();
  const parsed = extractJson(text);

  const now = new Date().toISOString();
  await api.updateAccount(accountId, {
    ai_summary: parsed.summary || '',
    ai_technical_drivers: parsed.technical_drivers || '',
    ai_environment: parsed.environment || '',
    ai_summary_updated_at: now
  });

  // Close out what the notes show is done or restated, then add only what's
  // genuinely new. Closing first means a step the model both closed and
  // re-proposed can't come back as a fresh row.
  const closedSteps = await applyStepReconciliation(accountId, stepHandles.byHandle, parsed);

  const existingTexts = new Set(
    (account.next_steps || []).map(s => s.text.trim().toLowerCase())
  );
  const addedSteps = [];
  for (const step of asArray(parsed.next_steps)) {
    const t = (typeof step === 'string' ? step : String(step || '')).trim();
    if (!t) continue;
    // Exact-text guard is only a backstop now; the prompt does the real work of
    // not restating an open step.
    if (existingTexts.has(t.toLowerCase())) continue;
    existingTexts.add(t.toLowerCase());
    await api.createNextStep({ account_id: accountId, text: t, source: 'ai' });
    addedSteps.push(t);
  }

  const updated = await api.getAccount(accountId);
  updated._stepChanges = { closed: closedSteps, added: addedSteps };
  return updated;
}

// Reconcile next steps without touching the AI summary — what the
// "Consolidate" button on the account page runs. Same contract as the full
// extraction; the summary fields that come back are simply ignored.
export async function consolidateNextSteps(accountId) {
  const key = getApiKey();
  if (!key) throw new Error('Anthropic API key not set. Add it in Settings.');

  const account = await api.getAccount(accountId);
  const stepHandles = openStepHandles(account);
  if (!stepHandles.open.length) return { closed: [], added: [], openBefore: 0 };

  const corpus = buildCorpus(account);
  if (!corpus.trim()) return { closed: [], added: [], openBefore: stepHandles.open.length };

  const text = await generateText({
    system: SYSTEM_PROMPT,
    user: corpus + renderOpenSteps(stepHandles.byHandle),
    maxTokens: 4096
  });
  const parsed = extractJson(text);

  const closed = await applyStepReconciliation(accountId, stepHandles.byHandle, parsed);
  return { closed, added: [], openBefore: stepHandles.open.length };
}

export const CRM_SNAPSHOT_MAX = 255;

// Generic browser-side Anthropic text call (key stays in the browser).
export async function generateText({ system, user, maxTokens = 1024 }) {
  const key = getApiKey();
  if (!key) throw new Error('Anthropic API key not set. Add it in Settings.');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json.content || []).map(b => b.text || '').join('').trim();
}

export function generateKickoffAgenda(context) {
  return generateText({
    maxTokens: 1024,
    system: 'You are an OPSWAT Solutions Engineer creating a focused 45-minute POV kickoff agenda with explicit time slots (e.g. "0:00–0:05 Introductions"). Return only the agenda, no preamble.',
    user: context
  });
}

function buildSnapshotCorpus(account) {
  const noteBlocks = (account.notes || []).map(n =>
    `## Note — ${n.date}\n${n.raw_notes || ''}`
  );
  const transcriptBlocks = (account.transcripts || []).map(t =>
    `## Transcript — ${t.title || 'Untitled'} (${t.call_date || ''})\n${t.content || ''}`
  );
  const stageVal = account.presales_stage || account.opportunity_stage;
  const stage = stageVal ? `Stage: ${stageVal}` : '';
  return [`# Account: ${account.account_name}`, stage, ...noteBlocks, ...transcriptBlocks]
    .filter(Boolean)
    .join('\n\n');
}

export async function generateCRMSnapshot(accountId) {
  const key = getApiKey();
  if (!key) throw new Error('Anthropic API key not set. Add it in Settings.');

  const account = await api.getAccount(accountId);
  const corpus = buildSnapshotCorpus(account);
  if (!corpus.trim() || (!(account.notes || []).length && !(account.transcripts || []).length)) {
    throw new Error('No notes or transcripts to summarize yet.');
  }

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 512,
    system: buildSnapshotSystemPrompt(account.presales_stage),
    messages: [{ role: 'user', content: `Account notes and transcripts:\n\n${corpus}` }]
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const json = await res.json();
  const raw = (json.content || []).map(b => b.text || '').join('');
  let text = tidySnapshot(raw, account.account_name);

  // Guarantee a complete, in-budget snapshot. If it exceeds the ceiling or got
  // cut off mid-thought, ask the model to compress it into a finished sentence;
  // sentence-aware trimming is the final safety net (never cuts mid-word).
  if (text.length > CRM_SNAPSHOT_MAX || !endsComplete(text)) {
    try {
      const t2 = tidySnapshot(await compressSnapshot(text || raw), account.account_name);
      text = (t2 && t2.length <= CRM_SNAPSHOT_MAX && endsComplete(t2)) ? t2 : trimToSentence(t2 || text, CRM_SNAPSHOT_MAX);
    } catch {
      text = trimToSentence(text, CRM_SNAPSHOT_MAX);
    }
  }
  if (text.length > CRM_SNAPSHOT_MAX) text = trimToSentence(text, CRM_SNAPSHOT_MAX);

  return api.createCrmSnapshot(accountId, { snapshot_text: text });
}

export async function runAIWithSnapshot(accountId) {
  const extractionPromise = runAIExtraction(accountId);
  const snapshotPromise = generateCRMSnapshot(accountId).catch(e => {
    console.warn('CRM snapshot generation failed:', e);
    return null;
  });
  const account = await extractionPromise;
  await snapshotPromise;
  return account;
}

// Runs all four extractions triggered on note save, in parallel:
//   1. AI summary (technical drivers / environment)   [client]
//   2. Next steps                                      [client, part of #1]
//   3. CRM snapshot (stage-aware)                      [client]
//   4. Deal intelligence merge + contact extraction    [server, key forwarded]
// Returns a summary used for the "Note saved. X fields updated." toast.
export async function runFullExtraction(accountId, noteId, transcriptId) {
  const key = getApiKey();
  const body = {};
  if (noteId) body.note_id = noteId;
  if (transcriptId) body.transcript_id = transcriptId;

  // Contact extraction (and best-effort deal-intel) runs server-side and does
  // NOT need a key, so always call it. Summary + CRM snapshot need the key.
  const serverPromise = api.runExtraction(accountId, body)
    .catch(e => { console.warn('Server extraction failed:', e); return null; });

  // Capture the AI-summary outcome so a failure is surfaced to the user instead
  // of silently looking like success (the toast otherwise reports only the
  // server-side fields, which succeed independently of the summary).
  let summaryError = null;
  let stepChanges = { closed: [], added: [] };
  const aiTasks = [];
  if (key) {
    aiTasks.push(runAIExtraction(accountId).then(acct => {
      // Reconciliation happens inside runAIExtraction; carry the outcome out so
      // the toast can say what was closed rather than leaving the list to
      // change silently.
      if (acct && acct._stepChanges) stepChanges = acct._stepChanges;
      return acct;
    }).catch(e => {
      console.warn('AI extraction failed:', e);
      summaryError = e.message || String(e);
      return null;
    }));
    aiTasks.push(generateCRMSnapshot(accountId).catch(e => { console.warn('Snapshot failed:', e); return null; }));
  }
  const [serverRes] = await Promise.all([serverPromise, ...aiTasks]);

  return {
    fieldsUpdated: serverRes ? (serverRes.fields_updated || []) : [],
    contacts: serverRes ? (serverRes.contacts || []) : [],
    hasKey: Boolean(key),
    summaryError,
    stepsClosed: stepChanges.closed,
    stepsAdded: stepChanges.added
  };
}
