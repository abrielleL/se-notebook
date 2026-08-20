import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import DatePicker from 'react-datepicker';
import { api } from '../lib/api.js';
import { hasApiKey, runAIWithSnapshot } from '../lib/ai.js';
import { todayISO, parseISODate, toISODate } from '../lib/stage.js';
import Icon from '../components/Icons.jsx';

export default function AddNote() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [account, setAccount] = useState(null);
  const meetingId = params.get('meeting');
  const [date, setDate] = useState(params.get('date') || todayISO());
  const [raw, setRaw] = useState(params.get('title') ? `Meeting: ${params.get('title')}\n\n` : '');
  const draftKey = `add_note_draft_${id}_v1`;
  const [draftSaved, setDraftSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.getAccount(id).then(setAccount).catch(e => setErr(e.message)); }, [id]);

  useEffect(() => {
    const saved = localStorage.getItem(draftKey);
    if (saved && !params.get('title')) {
      try { const d = JSON.parse(saved); setDate(d.date || todayISO()); setRaw(d.raw || ''); } catch {}
    }
  }, [draftKey]);

  useEffect(() => {
    const t = setInterval(() => {
      localStorage.setItem(draftKey, JSON.stringify({ date, raw }));
      setDraftSaved(true);
      setTimeout(() => setDraftSaved(false), 1500);
    }, 60000);
    return () => clearInterval(t);
  }, [date, raw, draftKey]);

  useEffect(() => {
    function onKey(e) {
      if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function save() {
    if (!raw.trim()) { setErr('Notes required'); return; }
    setSaving(true); setErr('');
    try {
      await api.createNote({ account_id: id, date, raw_notes: raw });
      if (meetingId) await api.updateMeeting(meetingId, { has_note: 1 });
      if (hasApiKey()) {
        try { await runAIWithSnapshot(id); } catch (e) { console.warn(e); }
      }
      localStorage.removeItem(draftKey);
      navigate(`/accounts/${id}`);
    } catch (e) {
      setErr(e.message); setSaving(false);
    }
  }

  return (
    <div className="p-8 max-w-3xl mx-auto pb-20">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-start gap-3">
          <button onClick={() => navigate(`/accounts/${id}`)} className="text-text-muted hover:text-text-primary mt-1">
            <Icon.Back />
          </button>
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Add Note</h1>
            <div className="text-[12px] text-text-muted mt-1">
              {account?.account_name || '…'} · Appending to running log
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[11px] flex items-center gap-1.5 transition ${draftSaved ? 'text-accent-green' : 'text-text-dim'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${draftSaved ? 'bg-accent-green' : 'bg-text-dim'}`} /> Draft saved
          </span>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 bg-accent-blue/15 hover:bg-accent-blue/25 text-accent-blue border border-accent-blue/30 rounded px-3.5 py-1.5 text-[12px] font-medium disabled:opacity-50"
          >
            <Icon.Sparkles width={12} height={12} />
            {saving ? 'Saving…' : 'Save + AI Update'}
          </button>
        </div>
      </div>

      {err && <div className="mb-4 text-accent-red text-[12px]">{err}</div>}

      <div className="mb-4">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[11px] text-text-muted">Date</span>
          {date === todayISO() && <span className="text-[10px] text-text-dim">Auto-filled · today</span>}
        </div>
        <DatePicker
          selected={parseISODate(date)}
          onChange={(d) => setDate(toISODate(d))}
          dateFormat="MMM d, yyyy"
          placeholderText="Select date"
          className="w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary focus:outline-none focus:border-accent-blue/50"
          popperPlacement="bottom-start"
        />
      </div>

      <div className="mb-4">
        <span className="block text-[11px] text-text-muted mb-1">Raw Notes</span>
        <textarea
          autoFocus
          value={raw}
          onChange={e => setRaw(e.target.value)}
          placeholder="Type everything here. AI extracts summary, technical drivers, environment, and next steps automatically on save."
          className="w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50 min-h-[260px] leading-relaxed"
        />
      </div>

      <div className="bg-accent-blue/5 border border-accent-blue/20 rounded p-3 flex items-start gap-2 text-[12px] text-text-secondary">
        <Icon.Sparkles className="text-accent-blue shrink-0 mt-0.5" width={13} height={13} />
        <div>AI will re-extract all fields from the full note log and all transcripts on save.</div>
      </div>
    </div>
  );
}
