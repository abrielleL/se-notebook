const express = require('express');
const llm = require('../lib/llm');
const { getKey, callAnthropic, DEFAULT_MODEL } = require('../lib/anthropic');

const router = express.Router();

// Settings: where the local model lives and which features use it.
router.get('/llm/settings', (_req, res) => {
  res.json({ config: llm.read(), features: llm.FEATURES });
});

router.put('/llm/settings', (req, res) => {
  const { config, error } = llm.validate(req.body || {});
  if (error) return res.status(400).json({ error });
  res.json({ config: llm.write(config), features: llm.FEATURES });
});

// Models the local server offers. Takes an unsaved URL so Settings can browse
// before saving.
router.get('/llm/models', async (req, res) => {
  const config = { ...llm.read(), ...(req.query.base_url ? { local_base_url: String(req.query.base_url).replace(/\/+$/, '') } : {}) };
  try {
    res.json({ models: await llm.listLocalModels(config) });
  } catch (e) {
    res.status(502).json({ error: `Couldn't reach ${config.local_base_url}: ${e.message}` });
  }
});

// A one-line round trip, to prove the server, model and context all work.
router.post('/llm/test', async (req, res) => {
  const { config, error } = llm.validate(req.body || {});
  if (error) return res.status(400).json({ error });
  const started = Date.now();
  try {
    const text = await llm.callLocal({
      config,
      system: 'Reply with exactly the words: local model ready',
      messages: [{ role: 'user', content: 'Ready?' }],
      max_tokens: 20
    });
    res.json({ ok: true, reply: text, ms: Date.now() - started, model: config.local_model });
  } catch (e) {
    res.status(e.status && e.status < 500 ? e.status : 502).json({ error: e.message });
  }
});

// Same check for Anthropic, using the key in the request header (the one
// typed in Settings, which may not be saved yet).
router.post('/llm/test-anthropic', async (req, res) => {
  const key = getKey(req);
  if (!key) return res.status(400).json({ error: 'Enter an API key first.' });
  const started = Date.now();
  try {
    const reply = await callAnthropic({
      key, model: DEFAULT_MODEL, max_tokens: 20,
      system: 'Reply with exactly the words: Anthropic ready',
      messages: [{ role: 'user', content: 'Ready?' }]
    });
    res.json({ ok: true, reply, ms: Date.now() - started, model: DEFAULT_MODEL });
  } catch (e) {
    // Anthropic's 401 body is long JSON; the status is what matters here.
    const m = /error (\d{3})/.exec(e.message);
    const msg = m && m[1] === '401' ? 'Anthropic rejected this key (401). Check it was copied in full.' : e.message;
    res.status(400).json({ error: msg.slice(0, 400) });
  }
});

// The browser's AI features call this instead of Anthropic directly, so the
// routing in Settings applies to them and nothing leaves the machine from the
// browser. Body: { feature, system, user, max_tokens }.
router.post('/llm/complete', async (req, res) => {
  const { feature, system, user, max_tokens } = req.body || {};
  if (!feature || !user) return res.status(400).json({ error: 'feature and user are required' });
  try {
    const out = await llm.complete({
      feature, key: getKey(req), system,
      messages: [{ role: 'user', content: String(user) }],
      max_tokens: Math.min(parseInt(max_tokens, 10) || 1024, 16000)
    });
    res.json(out);
  } catch (e) {
    res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.message });
  }
});

// Side by side: the same prompt through both models, nothing saved. Each side
// reports its own error, so one failing doesn't hide the other's answer.
router.post('/llm/compare', async (req, res) => {
  const { feature, system, user, max_tokens } = req.body || {};
  if (!feature || !user) return res.status(400).json({ error: 'feature and user are required' });
  const run = (provider) => llm.complete({
    feature, key: getKey(req), system, provider,
    messages: [{ role: 'user', content: String(user) }],
    max_tokens: Math.min(parseInt(max_tokens, 10) || 1024, 16000)
  }).catch(e => ({ provider, error: e.message }));
  const [anthropic, local] = await Promise.all([run('anthropic'), run('local')]);
  res.json({ anthropic, local, input_tokens_estimate: llm.estimateTokens(`${system || ''}\n${user}`) });
});

module.exports = router;
