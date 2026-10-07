// One door for every AI call that may run on either Anthropic or a local
// model (LM Studio, or anything else speaking the OpenAI chat-completions
// API). Each feature is routed independently from Settings, so a feature can
// be tried locally while the rest stay on Anthropic, and switched back with
// no other change.
//
// Defaults route everything to Anthropic: installing this changes nothing
// until a feature is switched in Settings.
//
// Local calls never silently truncate. If the prompt won't fit the context
// length configured here (which must match what the model was loaded with in
// LM Studio), the call fails and says so.

const db = require('../db/database');
const { callAnthropic, DEFAULT_MODEL } = require('./anthropic');

const SETTINGS_KEY = 'llm';

// `localOk: false` features stay on Anthropic for now; the reason is shown in
// Settings next to the disabled switch.
const FEATURES = [
  { key: 'summary', label: 'AI summary, drivers, environment & next steps', where: 'Saving a note or transcript; Consolidate' },
  { key: 'crm_snapshot', label: 'CRM snapshot', where: 'Saving a note or transcript' },
  { key: 'qualification', label: 'Qualification fields', where: 'Saving a note or transcript' },
  { key: 'participants', label: 'Transcript participants → contacts', where: 'Uploading a transcript' },
  { key: 'kickoff', label: 'POV kickoff agenda', where: 'POV calendar' },
  { key: 'company_profile', label: 'Company profile from website', where: 'Account page → Company' },
  { key: 'contact_profile', label: 'Contact profile parsing', where: 'Contact drawer → parse profile' },
  { key: 'deal_review', label: 'Deal review fill',
    where: 'Deal review → Refresh from notes. Locally it reads only the newest material that fits the model’s context; the refresh says what was skipped.' },
  { key: 'pov', label: 'POV generation', where: 'POV generator', localOk: false,
    reason: 'Kept on Anthropic until local quality is proven on everything else.' }
];
const FEATURE_KEYS = new Set(FEATURES.map(f => f.key));
const LOCAL_OK = new Set(FEATURES.filter(f => f.localOk !== false).map(f => f.key));

const DEFAULTS = {
  // LM Studio's default port, reached from inside Docker.
  local_base_url: 'http://host.docker.internal:1234/v1',
  local_model: '',
  local_context_tokens: 32768,
  // 'evidence': read each source, then answer from verified excerpts
  // (lib/dealReviewEvidence.js). 'single': the original one-pass read.
  deal_review_method: 'evidence',
  providers: {}
};

function read() {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY);
  let stored = {};
  if (row) { try { stored = JSON.parse(row.value) || {}; } catch { stored = {}; } }
  const config = { ...DEFAULTS, ...stored, providers: { ...(stored.providers || {}) } };
  for (const f of FEATURES) {
    if (config.providers[f.key] !== 'local' || !LOCAL_OK.has(f.key)) config.providers[f.key] = 'anthropic';
  }
  return config;
}

function validate(input) {
  const cur = read();
  const next = { ...cur };
  if (input.local_base_url != null) {
    const url = String(input.local_base_url).trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s]+$/.test(url)) return { error: 'Local server URL must start with http:// or https://' };
    next.local_base_url = url || DEFAULTS.local_base_url;
  }
  if (input.local_model != null) next.local_model = String(input.local_model).trim().slice(0, 200);
  if (input.local_context_tokens != null) {
    const n = parseInt(input.local_context_tokens, 10);
    if (!Number.isFinite(n) || n < 2048 || n > 1048576) return { error: 'Context length must be between 2,048 and 1,048,576 tokens' };
    next.local_context_tokens = n;
  }
  if (input.deal_review_method != null) {
    next.deal_review_method = input.deal_review_method === 'single' ? 'single' : 'evidence';
  }
  if (input.providers && typeof input.providers === 'object') {
    next.providers = { ...cur.providers };
    for (const [k, v] of Object.entries(input.providers)) {
      if (!FEATURE_KEYS.has(k)) continue;
      next.providers[k] = v === 'local' && LOCAL_OK.has(k) ? 'local' : 'anthropic';
    }
  }
  return { config: next };
}

function write(config) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(SETTINGS_KEY, JSON.stringify(config));
  return read();
}

const providerFor = (feature) => read().providers[feature] || 'anthropic';

// Whether a feature can run right now: local needs no key, Anthropic does.
// Lets callers skip a step quietly instead of failing on a missing key.
const canRun = (feature, key) => providerFor(feature) === 'local' || Boolean(key);

// --- local (OpenAI-compatible) ----------------------------------------------

const systemText = (system) =>
  Array.isArray(system) ? system.map(b => b.text || '').join('\n\n') : String(system || '');

const contentText = (content) =>
  Array.isArray(content) ? content.map(b => b.text || '').join('\n\n') : String(content || '');

// Rough count for the fit check only. Errs high: ~3.5 characters per token for
// English prose; transcripts with names and timestamps run denser.
const estimateTokens = (s) => Math.ceil(String(s || '').length / 3.5);

// Some local models think out loud in <think> tags before answering.
const stripThinking = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

// `response_format` (OpenAI shape) constrains the reply, e.g. to a JSON schema.
async function callLocal({ system, messages, max_tokens = 2048, config = read(), response_format }) {
  if (!config.local_model) {
    const e = new Error('No local model chosen. Pick one in Settings → Local model.');
    e.status = 400;
    throw e;
  }
  const sys = systemText(system);
  const msgs = [
    ...(sys ? [{ role: 'system', content: sys }] : []),
    ...messages.map(m => ({ role: m.role, content: contentText(m.content) }))
  ];
  const promptTokens = estimateTokens(msgs.map(m => m.content).join('\n'));
  if (promptTokens + max_tokens > config.local_context_tokens) {
    const e = new Error(
      `Too long for the local model: about ${promptTokens.toLocaleString()} tokens of input plus ` +
      `${max_tokens.toLocaleString()} for the answer, but its context is ${config.local_context_tokens.toLocaleString()}. ` +
      'Load the model with a longer context in LM Studio (and match it in Settings), or run this feature on Anthropic.'
    );
    e.status = 413;
    throw e;
  }

  let res;
  try {
    res = await fetch(`${config.local_base_url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.local_model, messages: msgs, max_tokens, temperature: 0.3, stream: false,
        ...(response_format ? { response_format } : {})
      }),
      // Local generation on a laptop can take minutes for a long transcript.
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
  } catch (err) {
    const e = new Error(`Couldn't reach the local model at ${config.local_base_url}. Is LM Studio's server running? (${err.message})`);
    e.status = 502;
    throw e;
  }
  if (!res.ok) {
    const text = await res.text();
    const e = new Error(`Local model error ${res.status}: ${text.slice(0, 500)}`);
    e.status = 502;
    throw e;
  }
  const json = await res.json();
  const choice = (json.choices || [])[0] || {};
  if (choice.finish_reason === 'length') {
    const e = new Error('The local model’s answer was cut off (hit its output limit).');
    e.status = 502;
    throw e;
  }
  return stripThinking(choice.message && choice.message.content);
}

// --- the door ------------------------------------------------------------------

// Returns { text, provider, model, ms }. `provider` overrides the routing,
// which only the side-by-side comparison uses.
async function complete({ feature, key, system, messages, max_tokens = 2048, provider }) {
  if (!FEATURE_KEYS.has(feature)) throw new Error(`Unknown AI feature: ${feature}`);
  const config = read();
  const which = provider || config.providers[feature] || 'anthropic';
  const started = Date.now();
  if (which === 'local') {
    if (!LOCAL_OK.has(feature)) throw new Error(`${feature} runs on Anthropic only`);
    const text = await callLocal({ system, messages, max_tokens, config });
    return { text, provider: 'local', model: config.local_model, ms: Date.now() - started };
  }
  const text = await callAnthropic({ key, model: DEFAULT_MODEL, max_tokens, system, messages });
  return { text, provider: 'anthropic', model: DEFAULT_MODEL, ms: Date.now() - started };
}

// Text-only convenience for callers that just want the reply.
async function completeText(opts) {
  return (await complete(opts)).text;
}

// List what the local server has loaded or available.
async function listLocalModels(config = read()) {
  const res = await fetch(`${config.local_base_url}/models`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Local server answered ${res.status}`);
  const json = await res.json();
  return (json.data || []).map(m => m.id).filter(id => !/embed/i.test(id));
}

module.exports = {
  FEATURES, read, validate, write, providerFor, canRun,
  complete, completeText, callLocal, listLocalModels, estimateTokens
};
