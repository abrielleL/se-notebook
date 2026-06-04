import { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import Card, { CardHeader } from '../components/Card.jsx';
import Icon from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { useOnline } from '../lib/offline.jsx';
import { runFullExtraction } from '../lib/ai.js';
import { riskDot, dueColor, NOTE_TYPES, STAGE_BAR } from '../lib/constants.js';
import { stageBadgeClass } from '../lib/stages.js';
import { formatDate, todayISO } from '../lib/stage.js';

function daysFromToday(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 86400000);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function inThisMonth(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr); const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
}

function Metric({ label, value, accent }) {
  return (
    <div className="bg-[#10141b] rounded-lg px-4 py-3 flex flex-col gap-1">
      <div className={`text-[22px] font-semibold ${accent || 'text-text-primary'}`}>{value}</div>
      <div className="text-[11px] text-text-muted">{label}</div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const online = useOnline();
  const [accounts, setAccounts] = useState([]);
  const [details, setDetails] = useState({});
  const [povs, setPovs] = useState([]);
  const [loading, setLoading] = useState(true);

  const [qaAccount, setQaAccount] = useState('');
  const [qaType, setQaType] = useState('General');
  const [qaText, setQaText] = useState('');
  const [qaSaving, setQaSaving] = useState(false);

  async function load() {
    const accts = await api.listAccounts();
    setAccounts(accts);
    const detailList = await Promise.all(accts.map(a => api.getAccount(a.id).catch(() => null)));
    const povLists = await Promise.all(accts.map(a => api.listPov(a.id).catch(() => [])));
    const d = {};
    detailList.forEach((det, i) => { if (det) d[accts[i].id] = det; });
    setDetails(d);
    const flat = [];
    povLists.forEach((list, i) => list.forEach(p => flat.push({ ...p, _account: accts[i] })));
    setPovs(flat);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const allSteps = useMemo(() => {
    const out = [];
    for (const a of accounts) {
      const det = details[a.id];
      if (!det) continue;
      for (const s of det.next_steps || []) out.push({ ...s, _account: a });
    }
    return out;
  }, [accounts, details]);

  const metrics = useMemo(() => ({
    activePovs: povs.filter(p => p.status !== 'Closed').length,
    closing: povs.filter(p => inThisMonth(p.end_date)).length,
    openSteps: allSteps.filter(s => !s.completed).length,
    needAttention: accounts.filter(a => a.last_note_days_ago == null || a.last_note_days_ago >= 30).length
  }), [povs, allSteps, accounts]);

  const week = useMemo(() => {
    const items = [];
    for (const s of allSteps) {
      if (s.completed || !s.due_date) continue;
      const dd = daysFromToday(s.due_date);
      if (dd != null && dd <= 7) items.push({ kind: 'step', id: s.id, account: s._account, text: s.text, date: s.due_date, dd, step: s });
    }
    for (const p of povs) {
      const milestones = [
        ['Kickoff', p.start_date, '#58a6ff'],
        ['Mid-POV', p.start_date ? addDays(p.start_date, 7) : null, '#e3b341'],
        ['Close-out', p.end_date, '#3fb950'],
        ['Prereq deadline', p.start_date ? addDays(p.start_date, -1) : null, '#f85149']
      ];
      for (const [type, date, color] of milestones) {
        const dd = daysFromToday(date);
        if (date && dd != null && dd >= 0 && dd <= 7) items.push({ kind: 'pov', id: `${p.id}-${type}`, account: p._account, text: type, date, dd, color });
      }
    }
    return items.sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [allSteps, povs]);

  const pipeline = useMemo(() =>
    accounts
      .filter(a => !a.presales_stage || STAGE_BAR.includes(a.presales_stage))
      .map(a => {
        const det = details[a.id];
        const topStep = det ? (det.next_steps || []).find(s => !s.completed) : null;
        return { account: a, topStep };
      })
      .sort((x, y) => (y.account.last_note_days_ago || 0) - (x.account.last_note_days_ago || 0)),
  [accounts, details]);

  async function toggleStep(step) {
    await api.updateNextStep(step.id, { completed: !step.completed });
    setDetails(d => {
      const det = d[step._account.id];
      if (!det) return d;
      return { ...d, [step._account.id]: { ...det, next_steps: det.next_steps.map(s => s.id === step.id ? { ...s, completed: !s.completed } : s) } };
    });
  }

  async function quickAdd() {
    if (!qaAccount || !qaText.trim()) return;
    setQaSaving(true);
    try {
      const note = await api.createNote({ account_id: qaAccount, date: todayISO(), raw_notes: qaText, note_type: qaType, pending_ai_extraction: online ? 0 : 1 });
      if (online) {
        runFullExtraction(qaAccount, note.id)
          .then(r => { toast(`Note saved. ${r.fieldsUpdated.length} fields updated.`, 'success'); load(); })
          .catch(() => toast('Note saved. AI extraction failed.', 'warn'));
      } else {
        toast('Note saved offline.', 'warn');
      }
      setQaText('');
    } catch (e) {
      toast(`Save failed: ${e.message}`, 'error');
    } finally {
      setQaSaving(false);
    }
  }

  if (loading) return <div className="p-8 text-[12px] text-text-muted">Loading dashboard…</div>;

  return (
    <div className="p-6 max-w-[1200px] mx-auto flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-3">
        <Metric label="Active POVs" value={metrics.activePovs} accent="text-accent-blue" />
        <Metric label="Closing this month" value={metrics.closing} accent="text-accent-green" />
        <Metric label="Open next steps" value={metrics.openSteps} />
        <Metric label="Accounts needing attention" value={metrics.needAttention} accent="text-accent-red" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Your week" subtitle="Milestones & next steps due in 7 days" icon={Icon.Calendar} />
          <div className="p-3 flex flex-col gap-2">
            {week.length === 0 && <div className="text-[11px] text-text-dim px-1 py-3">Nothing due this week.</div>}
            {week.map(item => (
              <div key={item.kind + item.id} className="flex items-center gap-2.5 border border-border rounded px-3 py-2">
                {item.kind === 'step' ? (
                  <button onClick={() => toggleStep(item.step)}
                    className="w-3.5 h-3.5 rounded-full border border-text-dim hover:border-accent-green shrink-0" />
                ) : (
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: item.color }} />
                )}
                <Link to={`/accounts/${item.account.id}`} className="flex-1 min-w-0">
                  <div className="text-[12px] text-text-primary truncate">{item.text}</div>
                  <div className="text-[10px] text-text-dim truncate">{item.account.account_name}</div>
                </Link>
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-border shrink-0"
                  style={{ color: item.dd < 0 ? '#f85149' : dueColor(item.date) }}>
                  {item.dd < 0 ? 'Overdue' : formatDate(item.date)}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Pipeline health" subtitle="Active accounts" icon={Icon.Folder} />
          <div className="p-3 flex flex-col gap-2 max-h-[420px] overflow-auto">
            {pipeline.map(({ account, topStep }) => {
              const days = account.last_note_days_ago;
              const dayColor = days == null ? '#4a5568' : days > 30 ? '#f85149' : days > 14 ? '#e3b341' : '#8b949e';
              return (
                <button key={account.id} onClick={() => navigate(`/accounts/${account.id}`)}
                  className="text-left border border-border rounded px-3 py-2 hover:border-accent-blue/40 transition">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: riskDot(account.risk) }} />
                    <span className="text-[12px] text-text-primary truncate flex-1">{account.account_name}</span>
                    {account.presales_stage && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium ${stageBadgeClass(account.presales_stage)}`}>{account.presales_stage}</span>
                    )}
                    <span className="text-[10px] shrink-0" style={{ color: dayColor }}>
                      {days == null ? 'no notes' : `${days}d`}
                    </span>
                  </div>
                  {topStep && <div className="text-[10px] text-text-dim truncate mt-1 pl-[18px]">→ {topStep.text}</div>}
                </button>
              );
            })}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Quick add note" icon={Icon.Plus} />
        <div className="p-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <select value={qaAccount} onChange={e => setQaAccount(e.target.value)}
              className="flex-1 bg-[#0a0d11] border border-border rounded px-2 py-1.5 text-[12px] text-text-primary focus:outline-none focus:border-accent-blue/50">
              <option value="">Select account…</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
            </select>
            <select value={qaType} onChange={e => setQaType(e.target.value)}
              className="bg-[#0a0d11] border border-border rounded px-2 py-1.5 text-[12px] text-text-primary focus:outline-none focus:border-accent-blue/50">
              {NOTE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <textarea value={qaText} onChange={e => setQaText(e.target.value)} placeholder="Raw notes…" rows={4}
            className="w-full bg-[#0a0d11] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50 resize-none" />
          <div className="flex justify-end">
            <button onClick={quickAdd} disabled={!qaAccount || !qaText.trim() || qaSaving}
              className="bg-accent-blue/15 hover:bg-accent-blue/25 text-accent-blue border border-accent-blue/30 rounded px-4 py-1.5 text-[12px] font-medium disabled:opacity-40">
              {qaSaving ? 'Saving…' : 'Save + AI extract'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
