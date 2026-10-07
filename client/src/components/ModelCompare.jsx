import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Modal from './Modal.jsx';
import Markdown from './Markdown.jsx';
import {
  buildSummaryRequest, parseSummaryReply, buildSnapshotRequest, tidySnapshotReply, CRM_SNAPSHOT_MAX
} from '../lib/ai.js';

// Side-by-side: the exact prompt a feature sends, run through Anthropic and the
// local model at once. Nothing is saved — this is for judging the local model
// on real accounts before switching a feature over in Settings.

const TASKS = [
  { key: 'summary', label: 'AI summary & next steps' },
  { key: 'crm_snapshot', label: 'CRM snapshot' }
];

function buildRequest(task, account) {
  if (task === 'summary') {
    const { stepHandles, ...req } = buildSummaryRequest(account);
    return { req, stepHandles };
  }
  return { req: buildSnapshotRequest(account) };
}

function Bullets({ text }) {
  if (!text) return <div className="text-[11px] text-text-dim">—</div>;
  return <div className="text-[11px] text-text-secondary"><Markdown>{text}</Markdown></div>;
}

function SummaryResult({ text, stepHandles }) {
  let parsed;
  try { parsed = parseSummaryReply(text); } catch { parsed = null; }
  if (!parsed) {
    return (
      <div>
        <div className="text-[10px] text-accent-red mb-1">Couldn’t read this reply as JSON — extraction would fail on it.</div>
        <pre className="whitespace-pre-wrap text-[10px] text-text-muted font-mono">{text}</pre>
      </div>
    );
  }
  const open = stepHandles ? stepHandles.byHandle : {};
  const stepText = (id) => (open[id] && open[id].text) || id;
  const list = (v) => (Array.isArray(v) ? v : []);
  const heading = (t) => <div className="text-[9px] uppercase tracking-wider text-text-dim mt-3 mb-1">{t}</div>;
  return (
    <div>
      {heading('Summary')}<Bullets text={parsed.summary} />
      {heading('Technical drivers')}<Bullets text={parsed.technical_drivers} />
      {heading('Environment')}<Bullets text={parsed.environment} />
      {heading(`New next steps (${list(parsed.next_steps).length})`)}
      {list(parsed.next_steps).map((s, i) => (
        <div key={i} className="text-[11px] text-text-secondary">
          • {typeof s === 'string' ? s : s.text}{s && s.owner ? <span className="text-text-dim"> ({s.owner})</span> : null}
        </div>
      ))}
      {(list(parsed.completed_steps).length + list(parsed.duplicate_steps).length) > 0 && (
        <>
          {heading('Would close')}
          {list(parsed.completed_steps).map((s, i) => (
            <div key={`c${i}`} className="text-[11px] text-text-secondary">✓ {stepText(s.id)} <span className="text-text-dim">— done</span></div>
          ))}
          {list(parsed.duplicate_steps).map((s, i) => (
            <div key={`d${i}`} className="text-[11px] text-text-secondary">⇢ {stepText(s.id)} <span className="text-text-dim">— duplicate</span></div>
          ))}
        </>
      )}
    </div>
  );
}

function SnapshotResult({ text, accountName }) {
  const tidy = tidySnapshotReply(text, accountName);
  const over = tidy.length > CRM_SNAPSHOT_MAX;
  return (
    <div>
      <div className="text-[12px] text-text-secondary leading-relaxed">{tidy}</div>
      <div className={`text-[10px] mt-2 ${over ? 'text-accent-yellow' : 'text-text-dim'}`}>
        {tidy.length} / {CRM_SNAPSHOT_MAX} characters{over ? ' — would be shortened before saving' : ''}
      </div>
    </div>
  );
}

function Column({ title, side, task, stepHandles, accountName }) {
  return (
    <div className="flex-1 min-w-0 bg-[#040d1c] border border-border rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-medium text-text-primary">{title}</span>
        {side && !side.error && (
          <span className="text-[10px] text-text-dim">{(side.ms / 1000).toFixed(1)}s · {side.model}</span>
        )}
      </div>
      {!side && <div className="text-[11px] text-text-dim">Running…</div>}
      {side && side.error && <div className="text-[11px] text-accent-red whitespace-pre-wrap">{side.error}</div>}
      {side && !side.error && (task === 'summary'
        ? <SummaryResult text={side.text} stepHandles={stepHandles} />
        : <SnapshotResult text={side.text} accountName={accountName} />)}
    </div>
  );
}

export default function ModelCompareModal({ accountId, onClose }) {
  const [account, setAccount] = useState(null);
  const [task, setTask] = useState('summary');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [contextTokens, setContextTokens] = useState(null);

  useEffect(() => {
    // Unscoped, the way extraction reads it, so the prompt is the real one.
    api.getAccount(accountId).then(setAccount).catch(e => setError(e.message));
    api.getLlmSettings().then(r => setContextTokens(r.config.local_context_tokens)).catch(() => {});
  }, [accountId]);

  let built = null;
  let buildError = '';
  if (account) {
    try { built = buildRequest(task, account); } catch (e) { buildError = e.message; }
  }
  const estimate = built ? Math.ceil(((built.req.system || '').length + built.req.user.length) / 3.5) : 0;
  const tooBig = contextTokens && built && estimate + built.req.maxTokens > contextTokens;

  async function run() {
    if (!built) return;
    setRunning(true);
    setResult({ task, anthropic: null, local: null });
    setError('');
    try {
      const r = await api.llmCompare({
        feature: built.req.feature, system: built.req.system, user: built.req.user, max_tokens: built.req.maxTokens
      });
      setResult({ task, ...r, stepHandles: built.stepHandles });
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal title="Compare models" onClose={onClose} width="max-w-6xl">
      <div className="flex items-center gap-2 mb-3">
        {TASKS.map(t => (
          <button key={t.key} onClick={() => { setTask(t.key); setResult(null); }}
            className={`text-[11px] px-2.5 py-1 rounded border transition ${task === t.key
              ? 'border-accent-blue/60 bg-accent-blue/15 text-accent-blue'
              : 'border-border text-text-muted hover:text-text-primary'}`}>
            {t.label}
          </button>
        ))}
        <button onClick={run} disabled={running || !built}
          className="ml-auto bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium hover:bg-accent-blue/25 disabled:opacity-40">
          {running ? 'Running both…' : 'Run both'}
        </button>
      </div>
      <div className="text-[10px] text-text-dim mb-3">
        Same prompt the app sends today, over this account’s notes and transcripts (about {estimate.toLocaleString()} tokens).
        Nothing is saved. The Anthropic side uses your key as usual.
        {tooBig && <span className="text-accent-yellow"> That’s more than the local model’s {contextTokens.toLocaleString()}-token context, so its side will refuse — load it with a longer context in LM Studio.</span>}
      </div>
      {(error || buildError) && <div className="text-[11px] text-accent-red mb-3">{error || buildError}</div>}
      {result && result.task === task && (
        <div className="flex gap-3">
          <Column title="Anthropic" side={result.anthropic} task={task} stepHandles={result.stepHandles} accountName={account?.account_name} />
          <Column title="Local model" side={result.local} task={task} stepHandles={result.stepHandles} accountName={account?.account_name} />
        </div>
      )}
    </Modal>
  );
}
