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

const SYSTEM_PROMPT = `You are a solutions engineering assistant. Analyze the following account notes and call transcripts. Extract and return a JSON object with exactly these fields:
{
  "summary": "concise bullet-point summary covering deal status, key stakeholder, competitive risk, blockers, and momentum",
  "technical_drivers": "bullet list of key technical requirements and drivers",
  "environment": "description of current technical environment and architecture",
  "next_steps": ["array", "of", "action items as strings"]
}
Be concise and technical. In summary, technical_drivers, and environment, use simple '- ' bullet points, one per line. Do not use bold ('**'), italic ('*'), headings ('#'), or tables. Return only valid JSON, no other text.`;

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

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: corpus }]
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

  const existingSteps = account.next_steps || [];
  const existingTexts = new Set(existingSteps.map(s => s.text.trim().toLowerCase()));
  const aiSteps = Array.isArray(parsed.next_steps) ? parsed.next_steps : [];
  for (const step of aiSteps) {
    const t = (typeof step === 'string' ? step : String(step || '')).trim();
    if (!t) continue;
    if (existingTexts.has(t.toLowerCase())) continue;
    await api.createNextStep({ account_id: accountId, text: t, source: 'ai' });
  }

  return api.getAccount(accountId);
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
  const aiTasks = [];
  if (key) {
    aiTasks.push(runAIExtraction(accountId).catch(e => {
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
    summaryError
  };
}
