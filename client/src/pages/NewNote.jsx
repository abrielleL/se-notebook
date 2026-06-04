import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DatePicker from 'react-datepicker';
import { api } from '../lib/api.js';
import { hasApiKey, runAIWithSnapshot } from '../lib/ai.js';
import { todayISO, initials, colorForName, parseISODate, toISODate } from '../lib/stage.js';
import { PRESALES_STAGES } from '../lib/stages.js';
import Card, { CardHeader } from '../components/Card.jsx';
import Icon from '../components/Icons.jsx';

const DRAFT_KEY = 'new_note_draft_v1';

const emptyContact = () => ({ name: '', title: '' });

export default function NewNote() {
  const navigate = useNavigate();
  const [allAccounts, setAllAccounts] = useState([]);
  const [form, setForm] = useState(() => {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) try { return JSON.parse(saved); } catch {}
    return {
      account_id: null,
      account_name: '',
      account_executive: '',
      industry: '',
      presales_stage: '',
      date: todayISO(),
      raw_notes: '',
      contacts: [emptyContact()]
    };
  });
  const [draftSaved, setDraftSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => { api.listAccounts().then(setAllAccounts); }, []);

  useEffect(() => {
    const t = setInterval(() => {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(form));
      setDraftSaved(true);
      setTimeout(() => setDraftSaved(false), 1500);
    }, 60000);
    return () => clearInterval(t);
  }, [form]);

  useEffect(() => {
    function onKey(e) {
      if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey) {
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && !e.target?.isContentEditable) {
          e.preventDefault(); save();
        }
      } else if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const suggestions = useMemo(() => {
    const q = form.account_name.trim().toLowerCase();
    if (!q) return [];
    return allAccounts.filter(a => a.account_name.toLowerCase().includes(q)).slice(0, 6);
  }, [form.account_name, allAccounts]);

  function pickAccount(a) {
    setForm(f => ({
      ...f,
      account_id: a.id,
      account_name: a.account_name,
      account_executive: a.account_executive || f.account_executive,
      industry: a.industry || f.industry,
      presales_stage: a.presales_stage || f.presales_stage
    }));
    setShowSuggestions(false);
  }

  function setContact(idx, key, value) {
    setForm(f => {
      const c = [...f.contacts];
      c[idx] = { ...c[idx], [key]: value };
      return { ...f, contacts: c };
    });
  }
  function addContact() {
    setForm(f => ({ ...f, contacts: [...f.contacts, emptyContact()] }));
  }
  function removeContact(idx) {
    setForm(f => ({ ...f, contacts: f.contacts.filter((_, i) => i !== idx) }));
  }

  async function save() {
    if (!form.account_name.trim()) { setErr('Account Name required'); return; }
    if (!form.raw_notes.trim()) { setErr('Notes required'); return; }
    setErr(''); setSaving(true);
    try {
      let accountId = form.account_id;
      if (!accountId) {
        const account = await api.createAccount({
          account_name: form.account_name.trim(),
          account_executive: form.account_executive.trim() || null,
          industry: form.industry.trim() || null,
          presales_stage: form.presales_stage || null
        });
        accountId = account.id;
      } else {
        await api.updateAccount(accountId, {
          account_name: form.account_name.trim(),
          account_executive: form.account_executive.trim() || null,
          industry: form.industry.trim() || null,
          presales_stage: form.presales_stage || null
        });
      }

      await api.createNote({
        account_id: accountId,
        date: form.date,
        raw_notes: form.raw_notes
      });

      for (const c of form.contacts) {
        if (c.name.trim()) await api.createContact({ account_id: accountId, name: c.name.trim(), title: c.title.trim() });
      }

      if (hasApiKey()) {
        try { await runAIWithSnapshot(accountId); } catch (e) { console.warn(e); }
      }

      localStorage.removeItem(DRAFT_KEY);
      navigate(`/accounts/${accountId}`);
    } catch (e) {
      setErr(e.message);
      setSaving(false);
    }
  }

  function clearDraft() {
    localStorage.removeItem(DRAFT_KEY);
    setForm({
      account_id: null,
      account_name: '',
      account_executive: '',
      industry: '',
      presales_stage: '',
      date: todayISO(),
      raw_notes: '',
      contacts: [emptyContact()]
    });
  }

  return (
    <div className="p-8 max-w-4xl mx-auto pb-20">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">New Note</h1>
          <div className="text-[12px] text-text-muted mt-1">Capture once. AI extracts the rest.</div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[11px] flex items-center gap-1.5 transition ${draftSaved ? 'text-accent-green' : 'text-text-dim'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${draftSaved ? 'bg-accent-green' : 'bg-text-dim'}`} /> Draft saved
          </span>
          <button onClick={clearDraft} className="text-[11px] text-text-muted hover:text-accent-red">Clear draft</button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 bg-accent-blue/15 hover:bg-accent-blue/25 text-accent-blue border border-accent-blue/30 rounded px-3.5 py-1.5 text-[12px] font-medium disabled:opacity-50"
          >
            <Icon.Sparkles width={12} height={12} />
            {saving ? 'Saving…' : 'Save + AI Extract'}
          </button>
        </div>
      </div>

      {err && <div className="mb-4 text-accent-red text-[12px]">{err}</div>}

      <Card className="p-5 mb-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="relative">
            <Label>Account Name</Label>
            <input
              className={inputCls}
              value={form.account_name}
              onChange={e => { setForm(f => ({ ...f, account_id: null, account_name: e.target.value })); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="Type to search or create"
              autoFocus
            />
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute z-10 left-0 right-0 mt-1 bg-card border border-border rounded shadow-lg max-h-56 overflow-auto">
                {suggestions.map(a => (
                  <button
                    key={a.id}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => pickAccount(a)}
                    className="block w-full text-left px-3 py-2 text-[12px] hover:bg-[#14181f] text-text-primary"
                  >
                    {a.account_name}{a.account_executive ? <span className="text-text-dim"> · {a.account_executive}</span> : null}
                  </button>
                ))}
                {!suggestions.find(s => s.account_name.toLowerCase() === form.account_name.trim().toLowerCase()) && (
                  <div className="px-3 py-2 text-[11px] text-accent-blue border-t border-border">
                    Press Save to create “{form.account_name.trim()}”
                  </div>
                )}
              </div>
            )}
          </div>
          <div>
            <Label>Account Executive</Label>
            <input className={inputCls} value={form.account_executive} onChange={e => setForm(f => ({ ...f, account_executive: e.target.value }))} />
          </div>
          <div>
            <Label>Industry</Label>
            <input className={inputCls} value={form.industry} onChange={e => setForm(f => ({ ...f, industry: e.target.value }))} />
          </div>
          <div>
            <Label>Presales stage</Label>
            <select className={inputCls} value={form.presales_stage} onChange={e => setForm(f => ({ ...f, presales_stage: e.target.value }))}>
              <option value="">—</option>
              {PRESALES_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <Label hint={form.date === todayISO() ? 'Auto-filled · today' : ''}>Date</Label>
            <DatePicker selected={parseISODate(form.date)} onChange={(d) => setForm(f => ({ ...f, date: toISODate(d) }))} dateFormat="MMM d, yyyy" placeholderText="Select date" className={inputCls} popperPlacement="bottom-start" />
          </div>
        </div>
      </Card>

      <Card className="mb-5">
        <CardHeader
          title="Contacts"
          subtitle={`${form.contacts.filter(c => c.name.trim()).length} contact${form.contacts.filter(c => c.name.trim()).length === 1 ? '' : 's'}`}
          icon={Icon.Folder}
          right={<button onClick={addContact} className="flex items-center gap-1 text-[11px] text-accent-blue hover:underline"><Icon.Plus width={11} height={11} /> Add Contact</button>}
        />
        <div className="p-4 space-y-2">
          {form.contacts.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0"
                   style={{ background: `${colorForName(c.name || `c${i}`)}22`, color: colorForName(c.name || `c${i}`) }}>
                {initials(c.name || '?')}
              </div>
              <input className={`${inputCls} flex-1`} placeholder="Name" value={c.name} onChange={e => setContact(i, 'name', e.target.value)} />
              <input className={`${inputCls} flex-1`} placeholder="Title" value={c.title} onChange={e => setContact(i, 'title', e.target.value)} />
              {form.contacts.length > 1 && (
                <button onClick={() => removeContact(i)} className="text-text-muted hover:text-accent-red"><Icon.Trash width={12} height={12} /></button>
              )}
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-5">
        <Label>Raw Notes</Label>
        <textarea
          className={`${inputCls} min-h-[260px] leading-relaxed`}
          placeholder="Type everything here. AI extracts summary, technical drivers, environment, and next steps automatically on save."
          value={form.raw_notes}
          onChange={e => setForm(f => ({ ...f, raw_notes: e.target.value }))}
        />
      </div>

      <div className="bg-accent-blue/5 border border-accent-blue/20 rounded p-3 flex items-start gap-2 text-[12px] text-text-secondary">
        <Icon.Sparkles className="text-accent-blue shrink-0 mt-0.5" width={13} height={13} />
        <div>AI will extract: summary, technical drivers, environment, and next steps. All editable after saving.</div>
      </div>
    </div>
  );
}

function Label({ children, hint }) {
  return (
    <div className="flex items-baseline justify-between mb-1">
      <span className="text-[11px] text-text-muted">{children}</span>
      {hint && <span className="text-[10px] text-text-dim">{hint}</span>}
    </div>
  );
}

const inputCls = 'w-full bg-[#0a0d11] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50';
