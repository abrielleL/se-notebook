// Server-side Anthropic caller.
//
// The Anthropic key is NOT stored on the server. The browser forwards its
// localStorage key per-request via the `x-anthropic-key` header; we use it
// transiently for a single call. (An ANTHROPIC_API_KEY env var is honored as
// a fallback for headless/automated use, but the default model is BYO-key.)

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

function getKey(req) {
  return (req.get && req.get('x-anthropic-key')) || process.env.ANTHROPIC_API_KEY || '';
}

async function callAnthropic({ key, model = DEFAULT_MODEL, max_tokens = 2048, system, messages }) {
  if (!key) {
    const e = new Error('Anthropic API key required. Add it in Settings.');
    e.status = 400;
    throw e;
  }
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens, system, messages })
  });
  if (!res.ok) {
    const text = await res.text();
    const e = new Error(`Anthropic API error ${res.status}: ${text}`);
    e.status = 502;
    throw e;
  }
  const json = await res.json();
  return (json.content || []).map(b => b.text || '').join('').trim();
}

// Best-effort JSON extraction from a model response that may be fenced or
// surrounded by prose.
function extractJson(text) {
  const trimmed = (text || '').trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
  }
  throw new Error('Failed to parse JSON from AI response');
}

module.exports = { callAnthropic, getKey, extractJson, DEFAULT_MODEL };
