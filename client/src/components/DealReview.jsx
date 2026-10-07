import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import Icon from './Icons.jsx';
import Markdown from './Markdown.jsx';
import Modal from './Modal.jsx';
import { useToast } from './Toast.jsx';
import { formatDate } from '../lib/stage.js';

// The QUANtum deal review for one opportunity. The questions come from the
// server (server/lib/dealReviewQuestions.js) so the tab, the AI fill and the
// Word export all ask exactly the same thing.

const STATUS_OPTIONS = [
  { value: 'answered', label: 'Answered' },
  { value: 'partial', label: 'Partial' },
  { value: 'unanswered', label: 'Not answered' },
  { value: 'na', label: 'N/A' }
];
// Deal-killer items are red flags, not questions: the flag is either present
// or clear, and "flagged" is the bad outcome.
const KILLER_OPTIONS = [
  { value: 'flagged', label: 'Flag present' },
  { value: 'clear', label: 'Clear' },
  { value: 'unanswered', label: 'Unknown' }
];
const VOICE_OPTIONS = [
  { value: '', label: '—' },
  { value: 'customer', label: 'Customer’s words' },
  { value: 'team', label: 'Team’s read' },
  { value: 'inferred', label: 'Inferred' }
];
const VOICE_LABEL = { customer: 'Customer’s words', team: 'Team’s read', inferred: 'Inferred' };
const SOURCE_LABEL = { note: 'Note', transcript: 'Transcript', internal_call: 'Internal call', manual: 'Added by hand' };

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'gaps', label: 'Gaps' },
  { value: 'flags', label: 'Red flags' }
];

const statusOf = (a) => (a && a.status) || 'unanswered';
// 'local:<model id>' for the local model, a Claude model id otherwise.
const modelLabel = (m) => (!m ? '' : m.startsWith('local:') ? 'Local model' : 'Claude');
const isResolved = (s) => s === 'answered' || s === 'clear' || s === 'na';
const isGap = (s) => s === 'unanswered' || s === 'partial';

function StatusIcon({ status }) {
  const base = 'w-4 h-4 rounded-full flex items-center justify-center shrink-0 border';
  switch (status) {
    case 'answered':
    case 'clear':
      return <span className={`${base} bg-accent-green border-accent-green`}><Icon.Check width={10} height={10} className="text-[#040d1c]" /></span>;
    case 'partial':
      return <span className={`${base} border-accent-yellow`} style={{ background: 'linear-gradient(90deg, #ff9a4d 50%, transparent 50%)' }} />;
    case 'flagged':
      return <span className={`${base} bg-accent-red border-accent-red text-[#040d1c] text-[10px] font-bold`}>!</span>;
    case 'na':
      return <span className={`${base} border-border text-text-dim text-[10px]`}>–</span>;
    default:
      return <span className={`${base} border-text-dim`} />;
  }
}

function Badge({ children, color = '#838892' }) {
  return (
    <span className="text-[9px] px-1.5 py-px rounded-full whitespace-nowrap"
      style={{ color, background: `${color}1f`, border: `1px solid ${color}55` }}>
      {children}
    </span>
  );
}

function sectionCounts(section, answers) {
  const statuses = section.questions.map(q => statusOf(answers[q.key]));
  return {
    total: statuses.length,
    resolved: statuses.filter(isResolved).length,
    partial: statuses.filter(s => s === 'partial').length,
    flagged: statuses.filter(s => s === 'flagged').length
  };
}

// The facts the app works out for itself, shown in place of an AI answer.
function computedText(kind, f) {
  if (!f) return null;
  if (kind === 'age') {
    return f.age_days == null ? null : `${f.age_days} days (opened ${formatDate(f.created_at.slice(0, 10))})`;
  }
  if (kind === 'days_in_stage') {
    if (f.days_in_stage == null) return null;
    return `${f.presales_stage || 'No stage'} for ${f.days_in_stage_is_floor ? 'at least ' : ''}${f.days_in_stage} day${f.days_in_stage === 1 ? '' : 's'}`;
  }
  if (kind === 'slips') {
    const pushes = f.close_date_pushes || [];
    if (!pushes.length) return 'No close-date pushes recorded';
    const list = pushes.map(p => `${formatDate(p.from)} → ${formatDate(p.to)}`).join(', ');
    return `${f.quarter_slips} quarter slip${f.quarter_slips === 1 ? '' : 's'} · ${pushes.length} push${pushes.length === 1 ? '' : 'es'} (${list})`;
  }
  return null;
}

function AnswerEditor({ question, killer, answer, onSave, onClear, onCancel }) {
  const [status, setStatus] = useState(statusOf(answer));
  const [text, setText] = useState(answer?.answer || '');
  const [evidence, setEvidence] = useState(answer?.evidence || '');
  const [voice, setVoice] = useState(answer?.voice || '');
  const [saving, setSaving] = useState(false);
  const options = killer ? KILLER_OPTIONS : STATUS_OPTIONS;

  async function save() {
    setSaving(true);
    try { await onSave({ status, answer: text, evidence, voice: voice || null }); }
    finally { setSaving(false); }
  }

  const input = 'w-full bg-[#040d1c] border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50 resize-y';
  return (
    <div className="mt-2 ml-6 flex flex-col gap-2" onClick={e => e.stopPropagation()}>
      <div className="flex flex-wrap gap-1">
        {options.map(o => (
          <button key={o.value} onClick={() => setStatus(o.value)}
            className={`text-[10px] px-2 py-0.5 rounded border transition ${status === o.value
              ? 'border-accent-blue/60 bg-accent-blue/15 text-accent-blue'
              : 'border-border text-text-muted hover:text-text-primary'}`}>
            {o.label}
          </button>
        ))}
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={3} className={input}
        placeholder={killer ? 'What’s behind this flag…' : 'Answer…'} />
      <textarea value={evidence} onChange={e => setEvidence(e.target.value)} rows={2} className={`${input} italic`}
        placeholder="Supporting quote (optional)…" />
      <div className="flex items-center gap-2">
        <label className="text-[10px] text-text-dim">Whose words</label>
        <select value={voice} onChange={e => setVoice(e.target.value)}
          className="bg-[#040d1c] border border-border rounded px-1.5 py-0.5 text-[10px] text-text-primary focus:outline-none">
          {VOICE_OPTIONS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
        </select>
        <span className="ml-auto flex items-center gap-2">
          {answer && <button onClick={onClear} className="text-[11px] text-text-dim hover:text-accent-red">Clear</button>}
          <button onClick={onCancel} className="text-[11px] text-text-muted hover:text-text-primary">Cancel</button>
          <button onClick={save} disabled={saving}
            className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-2.5 py-1 text-[11px] font-medium hover:bg-accent-blue/25 disabled:opacity-40">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </span>
      </div>
      <div className="text-[9px] text-text-dim">Saving locks this answer, so a later AI refresh won’t change it.</div>
    </div>
  );
}

function QuestionRow({ question, killer, answer, forecast, appliesLabels, editing, onEdit, onSave, onClear, onUnlock }) {
  const status = statusOf(answer);
  const computed = question.computed ? computedText(question.computed, forecast) : null;
  const source = answer && (answer.source_label || SOURCE_LABEL[answer.source_type]);

  return (
    <div className={`px-2 py-1.5 rounded transition ${editing ? 'bg-[#111f42]' : 'hover:bg-[#111f42]/60 cursor-pointer'}`}
      onClick={() => !editing && onEdit()}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5"><StatusIcon status={status} /></span>
        <div className="min-w-0 flex-1">
          <div className={`text-[11px] leading-snug ${question.headline ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
            {question.text}
          </div>
          {(question.applies || question.manual || !!answer?.locked) && (
            <div className="flex flex-wrap items-center gap-1 mt-1">
              {question.applies && <Badge>{appliesLabels[question.applies] || question.applies}</Badge>}
              {question.manual && !question.computed && <Badge>Manual</Badge>}
              {answer && answer.locked ? (
                <button onClick={(e) => { e.stopPropagation(); onUnlock(); }}
                  title="Edited by hand, so the AI refresh skips it. Click to let the AI update it again."
                  className="text-[9px] text-text-dim hover:text-accent-blue">Locked</button>
              ) : null}
            </div>
          )}
          {computed && <div className="text-[11px] text-accent-blue mt-1">{computed}</div>}
          {!editing && answer && answer.answer && (
            <div className="text-[11px] text-text-secondary mt-1"><Markdown>{answer.answer}</Markdown></div>
          )}
          {!editing && answer && answer.evidence && (
            <div className="text-[10px] text-text-muted italic mt-1 border-l-2 border-border pl-2">“{answer.evidence.replace(/^["“]|["”]$/g, '')}”</div>
          )}
          {!editing && answer && (answer.voice || source || answer.updated_by === 'ai') && (
            <div className="flex items-center gap-1.5 mt-1 text-[9px] text-text-dim">
              {answer.voice && <Badge color={answer.voice === 'customer' ? '#4fd15c' : answer.voice === 'team' ? '#5c9bff' : '#838892'}>{VOICE_LABEL[answer.voice]}</Badge>}
              {source && <span>{source}{answer.source_date ? ` · ${formatDate(answer.source_date)}` : ''}</span>}
              {answer.updated_by === 'ai' && <span>· AI-filled{answer.ai_model ? ` by ${modelLabel(answer.ai_model)}` : ''} {formatDate(answer.updated_at)}</span>}
            </div>
          )}
        </div>
      </div>
      {editing && (
        <AnswerEditor question={question} killer={killer} answer={answer}
          onSave={onSave} onClear={onClear} onCancel={() => onEdit(null)} />
      )}
    </div>
  );
}

export default function DealReview({ accountId, opportunityId, multipleOpportunities }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editingKey, setEditingKey] = useState(null);
  const [filter, setFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Which model a refresh will use, from Settings → AI models.
  const [reviewModel, setReviewModel] = useState(null);
  useEffect(() => {
    api.getLlmSettings().then(r => setReviewModel(r.config.providers.deal_review === 'local'
      ? { local: true, name: r.config.local_model }
      : { local: false })).catch(() => {});
  }, [accountId]);

  async function load() {
    try {
      setData(await api.getDealReview(accountId, opportunityId));
      setError(null);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { setData(null); setEditingKey(null); load(); }, [accountId, opportunityId]);

  const oppId = data?.opportunity?.id;
  const answers = data?.answers || {};

  async function save(key, body) {
    try {
      const row = await api.saveDealReviewAnswer(accountId, key, { ...body, opportunity_id: oppId });
      setData(d => ({ ...d, answers: { ...d.answers, [key]: row } }));
      setEditingKey(null);
    } catch (e) { toast(e.message, 'error'); }
  }
  async function clear(key) {
    try {
      await api.clearDealReviewAnswer(accountId, key, oppId);
      setData(d => { const next = { ...d.answers }; delete next[key]; return { ...d, answers: next }; });
      setEditingKey(null);
    } catch (e) { toast(e.message, 'error'); }
  }
  async function unlock(key) {
    const a = answers[key];
    if (!a) return;
    await save(key, { status: a.status, answer: a.answer, evidence: a.evidence, voice: a.voice, locked: false });
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await api.refreshDealReview(accountId, oppId);
      setData(d => ({ ...d, answers: r.answers }));
      toast(refreshMessage(r), r.errors.length ? 'warn' : 'success');
    } catch (e) {
      toast(`Refresh failed: ${e.message}`, 'error');
    } finally {
      setRefreshing(false);
    }
  }

  async function exportDocx() {
    setExporting(true);
    try {
      const { blob, filename } = await api.exportDealReviewDocx(accountId, oppId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setExporting(false);
    }
  }

  const totals = useMemo(() => {
    if (!data) return null;
    const all = data.sections.map(s => sectionCounts(s, answers));
    return {
      total: all.reduce((n, c) => n + c.total, 0),
      resolved: all.reduce((n, c) => n + c.resolved, 0),
      partial: all.reduce((n, c) => n + c.partial, 0),
      flagged: all.reduce((n, c) => n + c.flagged, 0)
    };
  }, [data, answers]);

  if (error) return <div className="p-6 text-[12px] text-accent-red">Could not load the deal review: {error}</div>;
  if (!data) return <div className="p-6 text-[12px] text-text-muted">Loading deal review…</div>;

  const visible = (q) => {
    const s = statusOf(answers[q.key]);
    if (filter === 'gaps') return isGap(s);
    if (filter === 'flags') return s === 'flagged';
    return true;
  };

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: '220px 1fr' }}>
      {/* LEFT: summary + section nav */}
      <div className="flex flex-col gap-3 min-w-0 self-start sticky top-0">
        <div className="bg-card border border-border rounded-lg p-3">
          <RefreshButton counts={data.source_counts} internalCount={data.internal_calls.length}
            busy={refreshing} onClick={refresh}
            onExport={exportDocx} exporting={exporting} model={reviewModel} />
          {multipleOpportunities && (
            <div className="text-[10px] text-text-dim mb-2">Review for <span className="text-text-secondary">{data.opportunity.name}</span></div>
          )}
          <div className="text-[20px] font-semibold text-text-primary leading-none">
            {totals.resolved}<span className="text-[12px] text-text-dim font-normal">/{totals.total}</span>
          </div>
          <div className="text-[10px] text-text-muted mt-1">questions resolved</div>
          <div className="h-1.5 rounded-full bg-[#111f42] mt-2 overflow-hidden flex">
            <div className="bg-accent-green" style={{ width: `${(totals.resolved / totals.total) * 100}%` }} />
            <div className="bg-accent-yellow" style={{ width: `${(totals.partial / totals.total) * 100}%` }} />
          </div>
          <div className="flex gap-3 mt-2 text-[10px]">
            <span className="text-accent-yellow">{totals.partial} partial</span>
            <span className="text-accent-red">{totals.flagged} red flag{totals.flagged === 1 ? '' : 's'}</span>
          </div>

          <div className="flex gap-1 mt-3">
            {FILTERS.map(f => (
              <button key={f.value} onClick={() => setFilter(f.value)}
                className={`flex-1 whitespace-nowrap text-[10px] px-1 py-1 rounded border transition ${filter === f.value
                  ? 'border-accent-blue/60 bg-accent-blue/15 text-accent-blue'
                  : 'border-border text-text-muted hover:text-text-primary'}`}>
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col mt-3 border-t border-border pt-2">
            {data.sections.map(s => {
              const c = sectionCounts(s, answers);
              return (
                <a key={s.key} href={`#review-${s.key}`}
                  onClick={(e) => { e.preventDefault(); document.getElementById(`review-${s.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                  className="flex items-center gap-2 py-1 text-[10px] text-text-muted hover:text-text-primary">
                  <span className="w-4 text-text-dim">{s.number}</span>
                  <span className="truncate flex-1">{s.title}</span>
                  {c.flagged > 0 && <span className="text-accent-red">{c.flagged} flagged</span>}
                  <span className={c.resolved === c.total ? 'text-accent-green' : 'text-text-dim'}>{c.resolved}/{c.total}</span>
                </a>
              );
            })}
          </div>
        </div>

        <InternalCallsCard accountId={accountId} opportunityId={oppId} calls={data.internal_calls}
          onChange={(internal_calls) => setData(d => ({ ...d, internal_calls }))} />
      </div>

      {/* RIGHT: the questions */}
      <div className="flex flex-col gap-3 min-w-0">
        {data.sections.map(s => {
          const c = sectionCounts(s, answers);
          const [head, ...deeper] = s.questions;
          const shownDeeper = deeper.filter(visible);
          const showHead = visible(head);
          if (filter !== 'all' && !showHead && !shownDeeper.length) return null;
          const row = (q) => (
            <QuestionRow key={q.key} question={q} killer={s.killer && !q.headline} answer={answers[q.key]}
              forecast={data.forecast} appliesLabels={data.applies_labels}
              editing={editingKey === q.key}
              onEdit={(k = q.key) => setEditingKey(k)}
              onSave={(body) => save(q.key, body)}
              onClear={() => clear(q.key)}
              onUnlock={() => unlock(q.key)} />
          );
          return (
            <div key={s.key} id={`review-${s.key}`} className="bg-card border border-border rounded-lg scroll-mt-3">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] text-text-dim">{s.number}.</span>
                  <span className="text-[11px] font-medium text-text-primary truncate">{s.title}</span>
                  {s.applies && <Badge>{data.applies_labels[s.applies]}</Badge>}
                  {s.killer && <Badge color="#ff6b66">Red flags</Badge>}
                </div>
                <span className="text-[10px] text-text-dim shrink-0">
                  {c.resolved}/{c.total}{c.flagged ? <span className="text-accent-red"> · {c.flagged} flagged</span> : null}
                </span>
              </div>
              <div className="p-2 flex flex-col gap-0.5">
                {showHead && row(head)}
                {shownDeeper.length > 0 && (
                  <>
                    <div className="text-[9px] uppercase tracking-wider text-text-dim px-2 pt-2 pb-0.5">Go deeper</div>
                    {shownDeeper.map(row)}
                  </>
                )}
              </div>
            </div>
          );
        })}
        <TrackingFootnote forecast={data.forecast} />
      </div>
    </div>
  );
}

// History before the tracking table existed is unknown, so say where the
// stage/slip numbers start counting rather than letting them read as complete.
function TrackingFootnote({ forecast }) {
  if (!forecast?.tracked_since) return null;
  return (
    <div className="text-[10px] text-text-dim px-1">
      Stage and close-date changes are tracked from {formatDate(forecast.tracked_since.slice(0, 10))}; earlier history isn’t known.
    </div>
  );
}

function refreshMessage(r) {
  const parts = [`${r.provider === 'local' ? 'Local model' : 'Claude'} filled ${r.written} answer${r.written === 1 ? '' : 's'} from ${r.sources_read} source${r.sources_read === 1 ? '' : 's'}`];
  if (r.quotes_dropped) parts.push(`${r.quotes_dropped} quote${r.quotes_dropped === 1 ? '' : 's'} couldn't be found in the source and ${r.quotes_dropped === 1 ? 'was' : 'were'} left out`);
  if (r.sources_omitted.length) parts.push(`${r.sources_omitted.length} older call${r.sources_omitted.length === 1 ? '' : 's'} didn't fit and ${r.sources_omitted.length === 1 ? 'was' : 'were'} skipped`);
  if (r.errors.length) parts.push(`${r.errors.length} section${r.errors.length === 1 ? '' : 's'} failed (${r.errors[0].section}: ${r.errors[0].error.slice(0, 120)})`);
  return parts.join(' · ');
}

function RefreshButton({ counts, internalCount, busy, onClick, onExport, exporting, model }) {
  const total = counts.notes + counts.transcripts + internalCount;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return (
    <div className="mb-3 pb-3 border-b border-border">
      <button onClick={onClick} disabled={busy || !total}
        className="w-full flex items-center justify-center gap-1.5 bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium hover:bg-accent-blue/25 disabled:opacity-50">
        <Icon.Sparkles width={12} height={12} />
        {busy ? 'Reading the deal…' : 'Refresh from notes'}
      </button>
      <div className="text-[9px] text-text-dim mt-1.5 leading-snug">
        {model && (
          <span className={`block mb-0.5 ${model.local ? 'text-accent-green' : 'text-text-muted'}`}>
            Runs on {model.local ? `the local model${model.name ? ` (${model.name})` : ''} — stays on this Mac` : 'Anthropic'}
          </span>
        )}
        {busy
          ? (model && model.local
            ? 'Takes several minutes locally, one section at a time. Answers you edited by hand are left alone.'
            : 'Takes a minute or two. Answers you edited by hand are left alone.')
          : total
            ? `Reads ${plural(counts.notes, 'note')}, ${plural(counts.transcripts, 'transcript')} and ${plural(internalCount, 'internal call')}. Hand-edited answers are left alone.`
            : 'Add a note, transcript or internal call first.'}
      </div>
      <button onClick={onExport} disabled={exporting}
        title="Download this deal review as a Word document"
        className="w-full mt-2 flex items-center justify-center gap-1.5 bg-card border border-border rounded px-3 py-1.5 text-[12px] text-text-primary hover:border-accent-blue/40 disabled:opacity-50">
        <Icon.Export width={12} height={12} />
        {exporting ? 'Exporting…' : 'Export to Word'}
      </button>
    </div>
  );
}

// Internal (AE/SE) calls about this deal. They feed the deal review only --
// never the summary, POV or next steps -- and what they say counts as the
// team's read, not the customer's words.
function InternalCallsCard({ accountId, opportunityId, calls, onChange }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const fileRef = useRef(null);

  async function add({ text, title, file }) {
    const form = new FormData();
    if (opportunityId) form.append('opportunity_id', opportunityId);
    if (file) form.append('file', file);
    else { form.append('content', text); form.append('title', title || 'Internal call'); }
    try {
      onChange(await api.addInternalCall(accountId, form));
      setAdding(false);
      toast('Internal call added', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function remove(id) {
    try { onChange(await api.deleteInternalCall(id)); setConfirmId(null); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function view(id) {
    try { setViewing(await api.getInternalCall(id)); }
    catch (e) { toast(e.message, 'error'); }
  }

  return (
    <div className="bg-card border border-border rounded-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Icon.Mic width={13} height={13} className="text-text-muted" />
          <span className="text-[11px] font-medium text-text-primary">Internal calls ({calls.length})</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => fileRef.current?.click()} title="Upload a call file (.txt, .md, .pdf, .docx)"
            className="text-text-dim hover:text-accent-blue"><Icon.Upload width={12} height={12} /></button>
          <button onClick={() => setAdding(true)} title="Paste an internal call"
            className="text-text-dim hover:text-accent-blue"><Icon.Plus width={12} height={12} /></button>
          <input ref={fileRef} type="file" accept=".txt,.md,.pdf,.docx" className="hidden"
            onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) add({ file: f }); }} />
        </div>
      </div>
      <div className="p-3 flex flex-col gap-1.5">
        {!calls.length && (
          <div className="text-[10px] text-text-dim leading-snug">
            Calls between you and the AE about this deal. Used only here, and counted as the team’s read rather than the customer’s words.
          </div>
        )}
        {calls.map(c => (
          <div key={c.id} className="group flex items-center gap-2 text-[11px]">
            <button onClick={() => view(c.id)} className="min-w-0 flex-1 text-left hover:text-accent-blue">
              <div className="truncate text-text-secondary group-hover:text-accent-blue">{c.title}</div>
              <div className="text-[9px] text-text-dim">{formatDate(c.call_date || c.created_at)}</div>
            </button>
            {confirmId === c.id ? (
              <span className="flex items-center gap-1.5 text-[10px] shrink-0">
                <button onClick={() => remove(c.id)} className="text-accent-red">Delete</button>
                <button onClick={() => setConfirmId(null)} className="text-text-muted">Keep</button>
              </span>
            ) : (
              <button onClick={() => setConfirmId(c.id)} title="Delete this call"
                className="text-text-dim hover:text-accent-red opacity-0 group-hover:opacity-100 shrink-0">
                <Icon.Trash width={11} height={11} />
              </button>
            )}
          </div>
        ))}
      </div>
      {adding && <PasteInternalCallModal onClose={() => setAdding(false)} onSave={add} />}
      {viewing && (
        <Modal title={viewing.title || 'Internal call'} onClose={() => setViewing(null)} width="max-w-2xl">
          <div className="text-[10px] text-text-dim mb-2">{formatDate(viewing.call_date || viewing.created_at)}</div>
          <pre className="whitespace-pre-wrap text-[11px] text-text-secondary font-mono leading-relaxed max-h-[60vh] overflow-auto">{viewing.content}</pre>
        </Modal>
      )}
    </div>
  );
}

function PasteInternalCallModal({ onClose, onSave }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!text.trim()) return;
    setSaving(true);
    try { await onSave({ text, title: title.trim() }); }
    finally { setSaving(false); }
  }
  const input = 'w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[11px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50';
  return (
    <Modal title="Add internal call" onClose={onClose} width="max-w-2xl"
      footer={<>
        <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-primary">Cancel</button>
        <button onClick={save} disabled={saving || !text.trim()}
          className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium hover:bg-accent-blue/25 disabled:opacity-40">
          {saving ? 'Saving…' : 'Add call'}
        </button>
      </>}>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title, e.g. Deal sync with AE" className={`${input} mb-2`} />
      <textarea value={text} onChange={e => setText(e.target.value)} rows={16} placeholder="Paste the call transcript or notes…"
        className={`${input} font-mono leading-relaxed resize-y`} />
    </Modal>
  );
}
