import { api } from './api.js';

export const ANTHROPIC_KEY_STORAGE = 'anthropic_api_key';
export const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export function getApiKey() {
  return localStorage.getItem(ANTHROPIC_KEY_STORAGE) || '';
}

export function hasApiKey() {
  return Boolean(getApiKey());
}

// Stage-aware CRM snapshot guidance. Keyed to Sugar CRM presales stages.
// Natural language only — no field-label prefixes anywhere.
function snapshotInstruction(stage) {
  switch (stage) {
    case '1-Discovery':
      return 'Focus on business drivers and use cases uncovered, key stakeholders identified, and the agreed next step to advance to demo.';
    case '2-Demo':
      return 'Cover what was demoed, stakeholder reactions, technical gaps or questions raised, and the next step to advance toward planning.';
    case '3-Workshop':
    case '4-Planning':
      return 'Cover POV plan status, the number of agreed success criteria, prerequisites status, and the target kickoff date.';
    case '5-Deployment':
      return 'Cover the products being deployed, install status, configuration progress, and any blockers found.';
    case '6-In Progress':
      return 'Cover success criteria status (X of Y met), active technical risks or blockers, competitive status, and the immediate next action.';
    case '7-Technical Win':
      return 'Cover the win summary, the key technical differentiator that closed it, and the commercial next step.';
    case '8-Technical Loss':
      return 'Cover the loss reason and the technical gap or competitor that won.';
    case 'Stalled':
      return 'Cover what caused the stall, the last meaningful activity, and what would re-engage the customer.';
    default:
      return 'Cover the health and progress of the evaluation, risk to technical fit or timing, and the next step.';
  }
}

function buildSnapshotSystemPrompt(stage) {
  return `You are a solutions engineering assistant. Based on the following account notes and transcripts, generate a CRM status snapshot for the SE notes field on the opportunity record.

${snapshotInstruction(stage)}

Rules:
- Maximum 255 characters total — count carefully and stay under the limit
- Plain text only, no bullet points, no markdown, no line breaks
- Natural language only. Do NOT use field labels or prefixes such as "Risk:", "Tech:", "Env:", or "Next:" anywhere.
- Always end with the next step to push to the next stage or maintain momentum.
- Be ruthlessly concise — every character counts
- Return only the snapshot text, nothing else`;
}

const SYSTEM_PROMPT = `You are a solutions engineering assistant. Analyze the following account notes and call transcripts. Extract and return a JSON object with exactly these fields:
{
  "summary": "concise bullet-point summary covering deal status, key stakeholder, competitive risk, blockers, and momentum",
  "technical_drivers": "bullet list of key technical requirements and drivers",
  "environment": "description of current technical environment and architecture",
  "next_steps": ["array", "of", "action items as strings"]
}
Be concise and technical. Use bullet points in summary, technical_drivers, and environment fields. Return only valid JSON, no other text.`;

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
    max_tokens: 2048,
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
  let text = (json.content || []).map(b => b.text || '').join('').trim();
  text = text.replace(/\s*\n+\s*/g, ' ').trim();
  if (text.length > CRM_SNAPSHOT_MAX) text = text.slice(0, CRM_SNAPSHOT_MAX);

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
  const tasks = [
    api.runExtraction(accountId, body).catch(e => { console.warn('Server extraction failed:', e); return null; })
  ];
  if (key) {
    tasks.push(runAIExtraction(accountId).catch(e => { console.warn('AI extraction failed:', e); return null; }));
    tasks.push(generateCRMSnapshot(accountId).catch(e => { console.warn('Snapshot failed:', e); return null; }));
  }
  const [serverRes] = await Promise.all(tasks);

  return {
    fieldsUpdated: serverRes ? (serverRes.fields_updated || []) : [],
    contacts: serverRes ? (serverRes.contacts || []) : []
  };
}
