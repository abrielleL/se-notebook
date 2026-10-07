import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { ANTHROPIC_KEY_STORAGE } from '../lib/ai.js';
import Card from '../components/Card.jsx';
import { useToast } from '../components/Toast.jsx';

const FIELD = 'bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50';

// Both AI providers in one place: the Anthropic key, the local model served
// by LM Studio on this Mac, and which one each feature runs on. A feature on
// the local model never sends account data off the machine. The key and the
// connection fields save with their buttons; the per-feature switches save as
// soon as they're flipped.
//
// The Anthropic key stays in this browser's localStorage, as it always has;
// it is sent to the app's server per request and never stored there.
export default function LocalModelSettings() {
  const toast = useToast();
  const [config, setConfig] = useState(null);
  const [features, setFeatures] = useState([]);
  const [form, setForm] = useState(null);
  const [models, setModels] = useState(null);
  const [modelsError, setModelsError] = useState('');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const [saving, setSaving] = useState(false);
  const [keyValue, setKeyValue] = useState(localStorage.getItem(ANTHROPIC_KEY_STORAGE) || '');
  const [savedKey, setSavedKey] = useState(localStorage.getItem(ANTHROPIC_KEY_STORAGE) || '');
  const [keyTesting, setKeyTesting] = useState(false);
  const [keyTest, setKeyTest] = useState(null);

  async function load() {
    try {
      const r = await api.getLlmSettings();
      setConfig(r.config);
      setFeatures(r.features);
      setForm({
        local_base_url: r.config.local_base_url,
        local_model: r.config.local_model,
        local_context_tokens: r.config.local_context_tokens
      });
      loadModels(r.config.local_base_url);
    } catch (e) {
      toast(`Could not load AI model settings: ${e.message}`, 'error');
    }
  }
  useEffect(() => { load(); }, []);

  async function loadModels(baseUrl) {
    setModelsError('');
    try {
      setModels((await api.listLocalModels(baseUrl)).models);
    } catch (e) {
      setModels(null);
      setModelsError(e.message);
    }
  }

  async function saveConnection() {
    setSaving(true);
    try {
      const r = await api.saveLlmSettings(form);
      setConfig(r.config);
      toast('Local model settings saved', 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest({ ok: true, ...(await api.testLocalModel(form)) });
    } catch (e) {
      setTest({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  }

  function saveKey() {
    const k = keyValue.trim();
    if (k) localStorage.setItem(ANTHROPIC_KEY_STORAGE, k);
    else localStorage.removeItem(ANTHROPIC_KEY_STORAGE);
    setKeyValue(k);
    setSavedKey(k);
    toast(k ? 'Anthropic API key saved in this browser' : 'Anthropic API key removed', 'success');
  }

  function clearKey() {
    localStorage.removeItem(ANTHROPIC_KEY_STORAGE);
    setKeyValue('');
    setSavedKey('');
    setKeyTest(null);
  }

  async function testKey() {
    setKeyTesting(true);
    setKeyTest(null);
    try {
      setKeyTest({ ok: true, ...(await api.testAnthropic(keyValue.trim())) });
    } catch (e) {
      setKeyTest({ ok: false, error: e.message });
    } finally {
      setKeyTesting(false);
    }
  }

  async function setProvider(feature, provider) {
    try {
      const r = await api.saveLlmSettings({ providers: { [feature]: provider } });
      setConfig(r.config);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  if (!config || !form) return null;
  const dirty = form.local_base_url !== config.local_base_url
    || form.local_model !== config.local_model
    || Number(form.local_context_tokens) !== config.local_context_tokens;
  const localCount = Object.values(config.providers).filter(p => p === 'local').length;

  return (
    <Card className="p-6">
      <div className="text-[13px] font-medium text-text-primary mb-1">AI models</div>
      <p className="text-[12px] text-text-muted mb-4 leading-relaxed">
        Run each AI feature on Anthropic or on a local model served by LM Studio on this Mac. A feature
        on the local model never sends notes or transcripts off this machine. Use <span className="text-text-secondary">Compare</span> on
        an account’s AI summary to see both side by side before switching.
      </p>

      <div className="text-[12px] font-medium text-text-primary mb-1">Anthropic</div>
      <p className="text-[11px] text-text-dim mb-2 leading-relaxed">
        Your API key is stored only in this browser. It’s passed to this app’s server with each request that
        runs on Anthropic and never saved there. Create one at <span className="text-accent-blue">console.anthropic.com</span>.
      </p>
      <input type="password" value={keyValue} onChange={e => setKeyValue(e.target.value)}
        placeholder="sk-ant-..." autoComplete="off" className={`w-full ${FIELD} font-mono`} />
      <div className="flex items-center gap-2 mt-2">
        <button onClick={saveKey} disabled={keyValue.trim() === savedKey}
          className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium hover:bg-accent-blue/25 disabled:opacity-40">
          Save key
        </button>
        <button onClick={testKey} disabled={keyTesting || !keyValue.trim()}
          className="bg-card border border-border rounded px-3 py-1.5 text-[12px] text-text-primary hover:border-accent-blue/40 disabled:opacity-40">
          {keyTesting ? 'Testing…' : 'Test Anthropic'}
        </button>
        {savedKey && <button onClick={clearKey} className="text-[12px] text-text-muted hover:text-accent-red">Clear key</button>}
        {keyTest && (keyTest.ok
          ? <span className="text-[11px] text-accent-green">✓ Replied “{keyTest.reply}” in {(keyTest.ms / 1000).toFixed(1)}s</span>
          : <span className="text-[11px] text-accent-red">{keyTest.error}</span>)}
      </div>

      <div className="text-[12px] font-medium text-text-primary mt-5 pt-4 border-t border-border mb-2">Local model (LM Studio)</div>

      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 140px' }}>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-text-dim">Local server URL</span>
          <input value={form.local_base_url} onChange={e => setForm(f => ({ ...f, local_base_url: e.target.value }))}
            className={`${FIELD} font-mono`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-text-dim">Context length (tokens)</span>
          <input type="number" value={form.local_context_tokens}
            onChange={e => setForm(f => ({ ...f, local_context_tokens: e.target.value }))} className={FIELD} />
        </label>
      </div>
      <div className="text-[10px] text-text-dim mt-1">
        Keep <span className="font-mono">host.docker.internal</span> — it’s how the app’s container reaches LM Studio on this Mac.
        Set the context length to the one you load the model with in LM Studio.
      </div>

      <label className="flex flex-col gap-1 mt-3">
        <span className="text-[11px] text-text-dim flex items-center gap-2">
          Model
          <button onClick={() => loadModels(form.local_base_url)} className="text-accent-blue hover:underline">Refresh list</button>
        </span>
        {models && models.length ? (
          <select value={form.local_model} onChange={e => setForm(f => ({ ...f, local_model: e.target.value }))} className={FIELD}>
            <option value="">Choose a model…</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
            {form.local_model && !models.includes(form.local_model) && <option value={form.local_model}>{form.local_model} (not listed)</option>}
          </select>
        ) : (
          <input value={form.local_model} onChange={e => setForm(f => ({ ...f, local_model: e.target.value }))}
            placeholder="e.g. qwen/qwen3-30b-a3b-2507" className={`${FIELD} font-mono`} />
        )}
        {modelsError && <span className="text-[10px] text-accent-yellow">{modelsError}. Start LM Studio’s server, then Refresh list.</span>}
      </label>

      <div className="flex items-center gap-2 mt-3">
        <button onClick={saveConnection} disabled={!dirty || saving}
          className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium hover:bg-accent-blue/25 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save connection'}
        </button>
        <button onClick={runTest} disabled={testing || !form.local_model}
          className="bg-card border border-border rounded px-3 py-1.5 text-[12px] text-text-primary hover:border-accent-blue/40 disabled:opacity-40">
          {testing ? 'Testing…' : 'Test local model'}
        </button>
        {test && (test.ok
          ? <span className="text-[11px] text-accent-green">✓ Replied “{test.reply}” in {(test.ms / 1000).toFixed(1)}s</span>
          : <span className="text-[11px] text-accent-red">{test.error}</span>)}
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[12px] font-medium text-text-primary">Where each feature runs</div>
          <div className="text-[10px] text-text-dim">{localCount} on local model · switches save instantly</div>
        </div>
        <div className="flex flex-col">
          {features.map(f => {
            const current = config.providers[f.key];
            const localOk = f.localOk !== false;
            return (
              <div key={f.key} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-text-secondary">{f.label}</div>
                  <div className="text-[10px] text-text-dim">{localOk ? f.where : f.reason}</div>
                </div>
                <div className="flex rounded border border-border overflow-hidden shrink-0">
                  {['anthropic', 'local'].map(p => (
                    <button key={p} disabled={p === 'local' && !localOk}
                      onClick={() => current !== p && setProvider(f.key, p)}
                      title={p === 'local' && !localOk ? f.reason : undefined}
                      className={`text-[11px] px-3 py-1 transition disabled:opacity-30 disabled:cursor-not-allowed ${current === p
                        ? (p === 'local' ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-blue/15 text-accent-blue')
                        : 'text-text-muted hover:text-text-primary'}`}>
                      {p === 'anthropic' ? 'Anthropic' : 'Local'}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
