import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DatePicker from 'react-datepicker';
import { api } from '../lib/api.js';
import { runFullExtraction } from '../lib/ai.js';
import { todayISO, initials, colorForName, parseISODate, toISODate } from '../lib/stage.js';
import { PRESALES_STAGES } from '../lib/stages.js';
import { ACCOUNT_TYPE_TABS, accountType } from '../lib/constants.js';
import Card, { CardHeader } from '../components/Card.jsx';
import Icon from '../components/Icons.jsx';
import AccountTagEditor from '../components/AccountTagEditor.jsx';
import { upsertDraft, deleteDraft, getDraft, newDraftId } from '../lib/drafts.js';

const emptyContact = () => ({ name: '', title: '' });
const emptyForm = () => ({
  account_id: null,
  account_name: '',
  account_executive: '',
  industry: '',
  presales_stage: '',
  account_type: 'customer',
  tags: [],
  date: todayISO(),
  raw_notes: '',
  contacts: [emptyContact()]
});

export default function NewNote() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const resumeId = params.get('draft');
  const [allAccounts, setAllAccounts] = useState([]);
  const [tagCatalog, setTagCatalog] = useState([]);
  // Draft id for this editing session — resumed from ?draft, else new.
  const [draftId] = useState(() => resumeId || newDraftId());
  const [form, setForm] = useState(() => {
    if (resumeId) { const d = getDraft(resumeId); if (d?.payload) return { ...emptyForm(), ...d.payload }; }
    return emptyForm();
  });
  const [draftSaved, setDraftSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  // Optional transcript file dropped/picked at note-creation time. Kept out of
  // `form` (and the localStorage draft) since a File can't be serialized.
  const [transcriptFile, setTranscriptFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  function onTranscriptDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) setTranscriptFile(f);
  }
  function onTranscriptPick(e) {
    const f = e.target.files[0];
    if (f) setTranscriptFile(f);
    e.target.value = '';
  }

  useEffect(() => { api.listAccounts().then(setAllAccounts); }, []);
  useEffect(() => { api.listTags().then(setTagCatalog).catch(() => {}); }, []);

  // Autosave to the drafts store as you type (only once there's note content),
  // debounced so it doesn't thrash on every keystroke.
  useEffect(() => {
    if (!form.raw_notes.trim() && !form.account_name.trim()) return;
    const t = setTimeout(() => {
      upsertDraft({
        id: draftId,
        source: 'new-note',
        accountId: form.account_id,
        accountName: form.account_name,
        text: form.raw_notes,
        payload: form
      });
      setDraftSaved(true);
      setTimeout(() => setDraftSaved(false), 1500);
    }, 700);
    return () => clearTimeout(t);
  }, [form, draftId]);

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
      presales_stage: a.presales_stage || f.presales_stage,
      // An existing account already has a type and labels — show them rather
      // than the blank defaults, so saving can't silently downgrade a partner
      // back to a customer or wipe its tags.
      account_type: accountType(a),
      tags: a.tags || []
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
    if (!form.raw_notes.trim() && !transcriptFile) { setErr('Add notes or drop a transcript file'); return; }
    setErr(''); setSaving(true);
    try {
      const accountFields = {
        account_name: form.account_name.trim(),
        account_executive: form.account_executive.trim() || null,
        industry: form.industry.trim() || null,
        presales_stage: form.presales_stage || null,
        account_type: form.account_type || 'customer',
        tags: form.tags || []
      };
      let accountId = form.account_id;
      if (!accountId) {
        const account = await api.createAccount(accountFields);
        accountId = account.id;
      } else {
        await api.updateAccount(accountId, accountFields);
      }

      // See AddNote: pending_ai_extraction=1 is cleared server-side once the
      // extraction below runs, so a failure here is recoverable.
      let note = null;
      if (form.raw_notes.trim()) {
        note = await api.createNote({
          account_id: accountId,
          date: form.date,
          raw_notes: form.raw_notes,
          pending_ai_extraction: 1
        });
      }

      let transcript = null;
      if (transcriptFile) {
        const fd = new FormData();
        fd.append('account_id', accountId);
        fd.append('source', 'file_upload');
        fd.append('file', transcriptFile);
        transcript = await api.uploadTranscript(fd);
      }

      for (const c of form.contacts) {
        if (c.name.trim()) await api.createContact({ account_id: accountId, name: c.name.trim(), title: c.title.trim() });
      }

      // runFullExtraction covers the AI summary and CRM snapshot as well as the
      // server-side qualification + contact extraction this page used to skip.
      // Passing the transcript id also gets its participants extracted, which
      // never happened when a transcript was attached here.
      if (note || transcript) {
        try {
          await runFullExtraction(accountId, note ? note.id : null, transcript ? transcript.id : null);
        } catch (e) { console.warn('Extraction failed:', e); }
      }

      deleteDraft(draftId);
      navigate(`/accounts/${accountId}`);
    } catch (e) {
      setErr(e.message);
      setSaving(false);
    }
  }

  function clearDraft() {
    deleteDraft(draftId);
    setTranscriptFile(null);
    setForm(emptyForm());
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
                    className="block w-full text-left px-3 py-2 text-[12px] hover:bg-[#111f42] text-text-primary"
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
            <Label hint={form.account_id ? 'from existing account' : ''}>Account type</Label>
            <div className="flex items-center gap-1 p-1 bg-[#040d1c] border border-border rounded">
              {ACCOUNT_TYPE_TABS.map(t => {
                const active = (form.account_type || 'customer') === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, account_type: t.value }))}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1 rounded text-[12px] font-medium transition"
                    style={active
                      ? { background: `${t.color}1f`, color: t.color, boxShadow: `inset 0 0 0 1px ${t.color}59` }
                      : { color: '#838892' }}
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: active ? t.color : '#3a4460' }} />
                    {t.singular}
                  </button>
                );
              })}
            </div>
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
        <div className="mt-4 pt-4 border-t border-border">
          <Label hint="saved on the account">Labels</Label>
          <AccountTagEditor
            tags={form.tags || []}
            catalog={tagCatalog}
            onChange={(tags) => setForm(f => ({ ...f, tags }))}
          />
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

      <div className="mb-5">
        <Label hint="optional">Transcript file</Label>
        {transcriptFile ? (
          <div className="flex items-center gap-2 bg-card border border-border rounded px-3 py-2.5">
            <Icon.Mic width={14} height={14} className="text-text-muted shrink-0" />
            <span className="text-[12px] text-text-primary flex-1 truncate">{transcriptFile.name}</span>
            <span className="text-[10px] text-text-dim shrink-0">{(transcriptFile.size / 1024).toFixed(0)} KB</span>
            <button onClick={() => setTranscriptFile(null)} className="text-text-dim hover:text-accent-red shrink-0"><Icon.X width={12} height={12} /></button>
          </div>
        ) : (
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
            onDrop={onTranscriptDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition ${dragOver ? 'border-accent-blue bg-accent-blue/10' : 'border-border hover:border-text-dim'}`}
          >
            <input ref={fileInputRef} type="file" className="hidden" onChange={onTranscriptPick} />
            <div className="flex flex-col items-center gap-1">
              <Icon.Upload width={18} height={18} className="text-text-muted" />
              <span className="text-[11px] text-text-secondary">Drop a call transcript here or click to browse</span>
              <span className="text-[10px] text-text-dim">.txt, .md, .pdf, .docx — processed with AI on save</span>
            </div>
          </div>
        )}
      </div>

      <div className="bg-accent-blue/5 border border-accent-blue/20 rounded p-3 flex items-start gap-2 text-[12px] text-text-secondary">
        <Icon.Sparkles className="text-accent-blue shrink-0 mt-0.5" width={13} height={13} />
        <div>AI will extract summary, technical drivers, environment, and next steps from your notes{transcriptFile ? ' and transcript' : ''}. All editable after saving.</div>
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

const inputCls = 'w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50';
