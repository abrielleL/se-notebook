import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { api } from '../lib/api.js';
import Card from '../components/Card.jsx';
import Icon from '../components/Icons.jsx';
import Modal from '../components/Modal.jsx';
import TablerIcon from '../components/TablerIcon.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate, parseISODate, toISODate } from '../lib/stage.js';
import { POV_STATUSES } from '../lib/constants.js';

// ─── date helpers (no external libs) ────────────────────────────────────────

function ymd(date) {
  // returns "YYYY-MM-DD" in local time
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLocal(str) {
  // parse "YYYY-MM-DD" as local midnight to avoid UTC-shift issues
  if (!str) return null;
  const [y, m, d] = str.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function startOfMonth(y, m) { return new Date(y, m, 1); }
function endOfMonth(y, m)   { return new Date(y, m + 1, 0); }

function calendarDays(y, m) {
  // returns array of Date objects for the 6-row calendar grid
  const first = startOfMonth(y, m);
  const last  = endOfMonth(y, m);
  const days  = [];
  // leading blanks (Sunday = 0)
  for (let i = 0; i < first.getDay(); i++) days.push(null);
  for (let d = 1; d <= last.getDate(); d++) days.push(new Date(y, m, d));
  // trailing blanks to fill last row
  while (days.length % 7 !== 0) days.push(null);
  return days;
}

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

const DAY_HEADERS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ─── POV meeting types ───────────────────────────────────────────────────────
// User-scheduled meetings attached to a POV (not auto-derived from the dates).

const MEETING_TYPES = [
  { key: 'scoping',  label: 'Scoping Call', color: '#bc8cff' },
  { key: 'kickoff',  label: 'Kick Off',     color: '#58a6ff' },
  { key: 'checkin',  label: 'Check In',     color: '#e3b341' },
  { key: 'wrapup',   label: 'Wrap Up',      color: '#3fb950' },
];
const MEETING_BY_KEY = Object.fromEntries(MEETING_TYPES.map(m => [m.key, m]));

// POV status badge styling, keyed by lowercased status.
const POV_STATUS_STYLE = {
  draft: 'text-text-muted border-border',
  sent: 'text-accent-blue border-accent-blue/30 bg-accent-blue/10',
  'kicked off': 'text-accent-purple border-accent-purple/30 bg-accent-purple/10',
  'in progress': 'text-accent-yellow border-accent-yellow/30 bg-accent-yellow/10',
  closed: 'text-accent-green border-accent-green/30 bg-accent-green/10',
};
const statusClass = (s) => POV_STATUS_STYLE[(s || '').toLowerCase()] || 'text-text-muted border-border';

// Flatten a timeline's stored meetings into calendar-ready markers.
function getMeetingsForTimeline(tl) {
  return (tl.meetings || []).map(m => {
    const def = MEETING_BY_KEY[m.type] || { label: m.type, color: '#8b949e' };
    return { id: m.id, key: m.type, label: def.label, color: def.color, date: parseLocal(m.meeting_date), tl };
  }).filter(m => m.date);
}

// ─── input class shared across modal/popover ────────────────────────────────

const inputCls = [
  'w-full px-2.5 py-1.5 rounded bg-[#0d1117] border border-[#1e2530]',
  'text-[12px] text-[#e6edf3] placeholder-[#4a5568]',
  'focus:outline-none focus:border-[#58a6ff]/60',
].join(' ');

const selectCls = inputCls;

// ─── Add Timeline Modal ──────────────────────────────────────────────────────

function AddTimelineModal({ onClose, onSuccess }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState([]);
  const [acctQuery, setAcctQuery] = useState('');
  const [acctId, setAcctId]     = useState(null);
  const [acctName, setAcctName] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [label, setLabel]       = useState('');
  const [startStr, setStart]    = useState('');
  const [endStr, setEnd]        = useState('');
  const [status, setStatus]     = useState('Draft');
  const [saving, setSaving]     = useState(false);
  const dropRef = useRef(null);

  useEffect(() => {
    api.listAccounts().then(setAccounts).catch(() => {});
  }, []);

  // close dropdown on outside click
  useEffect(() => {
    function handler(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = useMemo(() => {
    if (!acctQuery.trim()) return accounts.slice(0, 10);
    const q = acctQuery.toLowerCase();
    return accounts.filter(a => a.account_name.toLowerCase().includes(q)).slice(0, 10);
  }, [accounts, acctQuery]);

  function selectAccount(a) {
    setAcctId(a.id);
    setAcctName(a.account_name);
    setAcctQuery(a.account_name);
    setShowDropdown(false);
  }

  // duration display
  const durationMsg = useMemo(() => {
    if (!startStr || !endStr) return null;
    const s = parseLocal(startStr);
    const e = parseLocal(endStr);
    if (!s || !e) return null;
    const diff = Math.round((e - s) / 86400000);
    if (diff <= 0) return { invalid: true, text: 'Invalid date range' };
    return { invalid: false, text: `${diff} day${diff !== 1 ? 's' : ''}` };
  }, [startStr, endStr]);

  const canSubmit = acctId && startStr && endStr && durationMsg && !durationMsg.invalid;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const body = { account_id: acctId, start_date: startStr, end_date: endStr, status };
      if (label.trim()) body.label = label.trim();
      await api.createTimeline(body);
      toast('Timeline added to calendar', 'success');
      onSuccess();
    } catch (e) {
      toast(e.message || 'Failed to create timeline', 'error');
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <>
      <button
        onClick={onClose}
        className="px-3 py-1.5 rounded text-[11px] text-[#8b949e] hover:text-[#e6edf3] border border-[#1e2530] hover:border-[#58a6ff]/40 transition"
      >
        Cancel
      </button>
      <button
        onClick={handleSubmit}
        disabled={!canSubmit || saving}
        className="px-3 py-1.5 rounded text-[11px] bg-[#58a6ff]/15 text-[#58a6ff] border border-[#58a6ff]/30 hover:bg-[#58a6ff]/25 transition disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {saving ? 'Adding…' : 'Add to calendar'}
      </button>
    </>
  );

  return (
    <Modal title="Add POV timeline" onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">

        {/* Account */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium text-[#8b949e] uppercase tracking-wider">
            Account <span className="text-[#f85149]">*</span>
          </label>
          <div className="relative" ref={dropRef}>
            <input
              className={inputCls}
              placeholder="Search accounts…"
              value={acctQuery}
              onChange={e => {
                setAcctQuery(e.target.value);
                setAcctId(null);
                setShowDropdown(true);
              }}
              onFocus={() => setShowDropdown(true)}
            />
            {showDropdown && filtered.length > 0 && (
              <div className="absolute z-50 mt-1 w-full bg-[#0d1117] border border-[#1e2530] rounded-lg shadow-lg overflow-auto max-h-48">
                {filtered.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => selectAccount(a)}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#14181f] text-left transition"
                  >
                    <span className="text-[12px] text-[#e6edf3] truncate">{a.account_name}</span>
                    {a.presales_stage && (
                      <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded border border-[#1e2530] text-[#8b949e] shrink-0">
                        {a.presales_stage}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Label */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium text-[#8b949e] uppercase tracking-wider">Label</label>
          <input
            className={inputCls}
            placeholder="e.g. Q3 POV, Phase 2, Initial eval"
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-medium text-[#8b949e] uppercase tracking-wider">
              Start date <span className="text-[#f85149]">*</span>
            </label>
            <DatePicker
              selected={parseISODate(startStr)}
              onChange={d => setStart(toISODate(d))}
              dateFormat="MMM d, yyyy"
              placeholderText="Select date"
              className={inputCls}
              popperPlacement="bottom-start"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-medium text-[#8b949e] uppercase tracking-wider">
              End date <span className="text-[#f85149]">*</span>
            </label>
            <DatePicker
              selected={parseISODate(endStr)}
              onChange={d => setEnd(toISODate(d))}
              dateFormat="MMM d, yyyy"
              placeholderText="Select date"
              className={inputCls}
              popperPlacement="bottom-start"
            />
          </div>
        </div>

        {/* Duration indicator */}
        {durationMsg && (
          <div className={`text-[11px] ${durationMsg.invalid ? 'text-[#f85149]' : 'text-[#8b949e]'}`}>
            {durationMsg.text}
          </div>
        )}

        {/* Status */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium text-[#8b949e] uppercase tracking-wider">Status</label>
          <select
            className={selectCls}
            value={status}
            onChange={e => setStatus(e.target.value)}
          >
            {POV_STATUSES.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

      </div>
    </Modal>
  );
}

// ─── Add Event Modal (friendly entry point for scheduling a POV meeting) ─────

function AddEventModal({ timelines, defaultDate, onClose, onSuccess }) {
  const toast = useToast();
  const [query, setQuery]     = useState('');
  const [povId, setPovId]     = useState(null);
  const [showDrop, setShowDrop] = useState(false);
  const [type, setType]       = useState('scoping');
  const [dateStr, setDateStr] = useState(defaultDate || '');
  const [saving, setSaving]   = useState(false);
  const dropRef = useRef(null);

  useEffect(() => {
    function h(e) { if (dropRef.current && !dropRef.current.contains(e.target)) setShowDrop(false); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return timelines
      .map(t => ({ id: t.id, text: `${t.account_name}${t.label ? ' — ' + t.label : ''}`, start: t.start_date, end: t.end_date }))
      .filter(o => !q || o.text.toLowerCase().includes(q))
      .slice(0, 12);
  }, [timelines, query]);

  function selectPov(o) { setPovId(o.id); setQuery(o.text); setShowDrop(false); }

  const canSubmit = povId && type && dateStr;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await api.addPovMeeting({ pov_id: povId, type, meeting_date: dateStr });
      toast('Event added to calendar', 'success');
      onSuccess();
    } catch (e) {
      toast(e.message || 'Failed to add event', 'error');
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <>
      <button onClick={onClose}
        className="px-3 py-1.5 rounded text-[11px] text-[#8b949e] hover:text-[#e6edf3] border border-[#1e2530] hover:border-[#58a6ff]/40 transition">
        Cancel
      </button>
      <button onClick={submit} disabled={!canSubmit || saving}
        className="px-3 py-1.5 rounded text-[11px] bg-[#58a6ff]/15 text-[#58a6ff] border border-[#58a6ff]/30 hover:bg-[#58a6ff]/25 transition disabled:opacity-40 disabled:cursor-not-allowed">
        {saving ? 'Adding…' : 'Add event'}
      </button>
    </>
  );

  return (
    <Modal title="Add POV event" onClose={onClose} footer={footer}>
      {timelines.length === 0 ? (
        <div className="text-[12px] text-text-muted">
          No POVs on the calendar yet. Use “Add timeline” first, then you can attach events to it.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* POV picker */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-medium text-[#8b949e] uppercase tracking-wider">
              POV <span className="text-[#f85149]">*</span>
            </label>
            <div className="relative" ref={dropRef}>
              <input className={inputCls} placeholder="Search POVs by account…" value={query}
                onChange={e => { setQuery(e.target.value); setPovId(null); setShowDrop(true); }}
                onFocus={() => setShowDrop(true)} />
              {showDrop && options.length > 0 && (
                <div className="absolute z-50 mt-1 w-full bg-[#0d1117] border border-[#1e2530] rounded-lg shadow-lg overflow-auto max-h-48">
                  {options.map(o => (
                    <button key={o.id} type="button" onClick={() => selectPov(o)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-[#14181f] text-left transition">
                      <span className="text-[12px] text-[#e6edf3] truncate">{o.text}</span>
                      <span className="text-[9px] text-[#8b949e] shrink-0">{o.start} – {o.end}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Event type chips */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-medium text-[#8b949e] uppercase tracking-wider">Event type</label>
            <div className="flex flex-wrap gap-1.5">
              {MEETING_TYPES.map(t => {
                const active = type === t.key;
                return (
                  <button key={t.key} type="button" onClick={() => setType(t.key)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] border font-medium transition"
                    style={active
                      ? { color: t.color, background: `${t.color}26`, borderColor: `${t.color}88` }
                      : { color: '#8b949e', background: 'transparent', borderColor: '#1e2530' }}>
                    <span className="w-2 h-2 rounded-full" style={{ background: t.color }} />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Date */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-medium text-[#8b949e] uppercase tracking-wider">
              Date <span className="text-[#f85149]">*</span>
            </label>
            <DatePicker selected={parseISODate(dateStr)} onChange={d => setDateStr(toISODate(d))}
              dateFormat="MMM d, yyyy" placeholderText="Select date" className={inputCls} popperPlacement="bottom-start" />
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Timeline Popover (detail + meetings; editable for manual timelines) ─────

function EditPopover({ tl, pos, onClose, onReload }) {
  const toast = useToast();
  const ref   = useRef(null);
  const isManual = tl.manually_created === 1;

  const [label, setLabel]     = useState(tl.label || '');
  const [startStr, setStart]  = useState(tl.start_date || '');
  const [endStr, setEnd]      = useState(tl.end_date || '');
  const [status, setStatus]   = useState(tl.status || 'Draft');
  const [dateErr, setDateErr] = useState('');
  const [saving, setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  // meetings (seeded from the loaded timeline, then maintained locally)
  const [meetings, setMeetings] = useState(tl.meetings || []);
  const [mType, setMType] = useState('scoping');
  const [mDate, setMDate] = useState('');
  const [addingMeeting, setAddingMeeting] = useState(false);

  // close on outside click + Escape. Ignore clicks inside a react-datepicker
  // portal/popup — it renders outside this popover but must not close it.
  useEffect(() => {
    function handler(e) {
      if (e.target.closest?.('.react-datepicker, .react-datepicker__portal, .react-datepicker__tab-loop')) return;
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  useEffect(() => {
    function handler(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // clamp position to viewport
  const style = useMemo(() => {
    const W = window.innerWidth, H = window.innerHeight;
    const popW = 300, popH = 460;
    let x = pos.x + 8, y = pos.y + 8;
    if (x + popW > W - 8) x = W - popW - 8;
    if (y + popH > H - 8) y = H - popH - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    return { position: 'fixed', left: x, top: y, width: popW, zIndex: 50 };
  }, [pos]);

  async function handleSave() {
    if (!startStr || !endStr) { setDateErr('Start and end dates are required'); return; }
    const s = parseLocal(startStr), e = parseLocal(endStr);
    if (!s || !e || e <= s) { setDateErr('End date must be after start date'); return; }
    setDateErr(''); setSaving(true);
    try {
      await api.updateTimeline(tl.id, { label, start_date: startStr, end_date: endStr, status });
      onReload(); onClose();
    } catch (err) { toast(err.message || 'Failed to save', 'error'); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    setDeleting(true);
    try { await api.deleteTimeline(tl.id); onReload(); onClose(); }
    catch (err) { toast(err.message || 'Failed to delete', 'error'); setDeleting(false); }
  }

  async function addMeeting() {
    if (!mDate) return;
    setAddingMeeting(true);
    try {
      const m = await api.addPovMeeting({ pov_id: tl.id, type: mType, meeting_date: mDate });
      setMeetings(list => [...list, m].sort((a, b) => a.meeting_date.localeCompare(b.meeting_date)));
      setMDate('');
      onReload();
    } catch (err) { toast(err.message || 'Failed to add meeting', 'error'); }
    finally { setAddingMeeting(false); }
  }

  async function removeMeeting(id) {
    try {
      await api.deletePovMeeting(id);
      setMeetings(list => list.filter(m => m.id !== id));
      onReload();
    } catch (err) { toast(err.message || 'Failed to remove meeting', 'error'); }
  }

  return (
    <div ref={ref} style={style}
      className="bg-[#0d1117] border border-[#1e2530] rounded-lg shadow-lg p-3 flex flex-col gap-2.5 max-h-[88vh] overflow-y-auto">

      {/* header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={`/accounts/${tl.account_id}`} className="text-[12px] font-semibold text-accent-blue hover:underline truncate block">
            {tl.account_name}
          </Link>
          <div className="text-[10px] text-text-dim truncate">
            {tl.label || 'POV'} · {tl.start_date} – {tl.end_date}
          </div>
        </div>
        <button onClick={onClose} className="text-text-dim hover:text-text-primary shrink-0"><Icon.X width={12} height={12} /></button>
      </div>

      {/* meetings manager */}
      <div className="flex flex-col gap-1.5 pt-1 border-t border-[#1e2530]">
        <div className="text-[9px] font-medium text-[#8b949e] uppercase tracking-wider">POV meetings</div>
        {meetings.length === 0 && <div className="text-[10px] text-text-dim">No meetings scheduled yet.</div>}
        {meetings.map(m => {
          const def = MEETING_BY_KEY[m.type] || { label: m.type, color: '#8b949e' };
          return (
            <div key={m.id} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: def.color }} />
              <span className="text-[11px] text-text-secondary w-[68px] shrink-0">{def.label}</span>
              <span className="text-[11px] text-text-muted flex-1 truncate">{formatDate(m.meeting_date)}</span>
              <button onClick={() => removeMeeting(m.id)} className="text-text-dim hover:text-accent-red shrink-0" title="Remove meeting"><Icon.X width={10} height={10} /></button>
            </div>
          );
        })}
        {/* add meeting row */}
        <div className="flex items-center gap-1.5 mt-1">
          <select value={mType} onChange={e => setMType(e.target.value)}
            className="bg-[#0d1117] border border-[#1e2530] rounded px-1.5 py-1 text-[10px] text-text-primary focus:outline-none focus:border-accent-blue/60">
            {MEETING_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <DatePicker selected={parseISODate(mDate)} onChange={d => setMDate(toISODate(d))}
            dateFormat="MMM d, yyyy" placeholderText="Date" withPortal
            className="w-[96px] bg-[#0d1117] border border-[#1e2530] rounded px-1.5 py-1 text-[10px] text-text-primary focus:outline-none focus:border-accent-blue/60" />
          <button onClick={addMeeting} disabled={!mDate || addingMeeting}
            className="px-2 py-1 rounded text-[10px] bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25 transition disabled:opacity-40 shrink-0">
            {addingMeeting ? '…' : 'Add'}
          </button>
        </div>
      </div>

      {/* manual timelines: editable fields + delete; generated: link out */}
      {isManual ? (
        <div className="flex flex-col gap-2.5 pt-1 border-t border-[#1e2530]">
          <div className="text-[9px] font-medium text-[#8b949e] uppercase tracking-wider">Edit timeline</div>
          <input className={inputCls} value={label} onChange={e => setLabel(e.target.value)} placeholder="Timeline label" />
          <div className="grid grid-cols-2 gap-2">
            <DatePicker selected={parseISODate(startStr)} onChange={d => setStart(toISODate(d))} dateFormat="MMM d, yyyy" placeholderText="Start" className={inputCls} withPortal />
            <DatePicker selected={parseISODate(endStr)} onChange={d => setEnd(toISODate(d))} dateFormat="MMM d, yyyy" placeholderText="End" className={inputCls} withPortal />
          </div>
          <select className={selectCls} value={status} onChange={e => setStatus(e.target.value)}>
            {POV_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {dateErr && <div className="text-[10px] text-[#f85149]">{dateErr}</div>}
          {confirmDel ? (
            <div className="flex flex-col gap-1.5">
              <div className="text-[10px] text-[#f85149]">Remove from calendar?</div>
              <div className="flex gap-2">
                <button onClick={handleDelete} disabled={deleting} className="px-2 py-1 rounded text-[10px] bg-[#f85149]/15 text-[#f85149] border border-[#f85149]/30 hover:bg-[#f85149]/25 transition disabled:opacity-40">{deleting ? 'Deleting…' : 'Yes'}</button>
                <button onClick={() => setConfirmDel(false)} className="px-2 py-1 rounded text-[10px] text-[#8b949e] border border-[#1e2530] hover:text-[#e6edf3] transition">No</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <button onClick={() => setConfirmDel(true)} className="px-2 py-1 rounded text-[10px] text-[#f85149] border border-[#f85149]/20 hover:bg-[#f85149]/10 transition">Delete</button>
              <button onClick={handleSave} disabled={saving} className="px-2.5 py-1 rounded text-[10px] bg-[#58a6ff]/15 text-[#58a6ff] border border-[#58a6ff]/30 hover:bg-[#58a6ff]/25 transition disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          )}
        </div>
      ) : (
        <div className="pt-1 border-t border-[#1e2530]">
          <Link to={`/accounts/${tl.account_id}`} className="text-[10px] text-accent-blue hover:underline">Open account to edit this POV →</Link>
        </div>
      )}
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

export default function CalendarPage() {
  const navigate = useNavigate();
  const toast    = useToast();

  const [timelines, setTimelines] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState('');
  const [view, setView]           = useState('month'); // 'month' | 'quarter' | 'list'

  const [showAddModal, setShowAddModal]   = useState(false);
  const [eventModal, setEventModal]       = useState(null); // { date } | null
  const [popover, setPopover]             = useState(null); // { tl, pos }

  const today    = useMemo(() => new Date(), []);
  const todayStr = useMemo(() => ymd(today), [today]);

  const [curYear,  setCurYear]  = useState(today.getFullYear());
  const [curMonth, setCurMonth] = useState(today.getMonth()); // 0-indexed

  // ── data loading ──────────────────────────────────────────────────────────
  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.listTimelines();
      setTimelines(data || []);
      setErr('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // ── derived: all POV meetings ─────────────────────────────────────────────
  const allMeetings = useMemo(() => {
    const ms = [];
    timelines.forEach(tl => ms.push(...getMeetingsForTimeline(tl)));
    return ms;
  }, [timelines]);

  // ── stats ─────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const activePovs = timelines.filter(t =>
      t.status !== 'Closed' && t.win_loss == null
    ).length;

    const mStart = new Date(curYear, curMonth, 1);
    const mEnd   = new Date(curYear, curMonth + 1, 0);
    const closingThisMonth = timelines.filter(t => {
      if (!t.end_date) return false;
      const d = parseLocal(t.end_date);
      return d >= mStart && d <= mEnd;
    }).length;

    const weekEnd = addDays(today, 7);
    const meetingsThisWeek = allMeetings.filter(ms =>
      ms.date >= today && ms.date <= weekEnd
    ).length;

    const upcomingStarts = timelines.filter(t => {
      if (!t.start_date) return false;
      return parseLocal(t.start_date) > today;
    }).length;

    return { activePovs, closingThisMonth, meetingsThisWeek, upcomingStarts };
  }, [timelines, allMeetings, curYear, curMonth, today]);

  // ── calendar grid ─────────────────────────────────────────────────────────
  const days = useMemo(() => calendarDays(curYear, curMonth), [curYear, curMonth]);

  // map from "YYYY-MM-DD" -> { bars: [...], dots: [...] }
  const dayMap = useMemo(() => {
    const map = {};

    const ensure = str => {
      if (!map[str]) map[str] = { bars: [], dots: [] };
    };

    // timeline bars
    timelines.forEach(tl => {
      const barColor   = tl.account_color || '#378ADD';
      const barLabel   = tl.label || tl.account_name || '';
      const isManual   = tl.manually_created === 1;
      const start = tl.start_date ? parseLocal(tl.start_date) : null;
      const end   = tl.end_date   ? parseLocal(tl.end_date)   : null;
      if (!start && !end) return;

      const rangeStart = start || end;
      const rangeEnd   = end   || start;

      let cur = new Date(rangeStart);
      while (cur <= rangeEnd) {
        const key = ymd(cur);
        ensure(key);
        map[key].bars.push({
          tl,
          barColor,
          isStart:  ymd(cur) === ymd(rangeStart),
          isEnd:    ymd(cur) === ymd(rangeEnd),
          label:    barLabel,
          isManual,
        });
        cur = addDays(cur, 1);
      }
    });

    // meeting dots
    allMeetings.forEach(ms => {
      const key = ymd(ms.date);
      ensure(key);
      map[key].dots.push(ms);
    });

    return map;
  }, [timelines, allMeetings]);

  // ── navigation ────────────────────────────────────────────────────────────
  function prevMonth() {
    if (curMonth === 0) { setCurYear(y => y - 1); setCurMonth(11); }
    else setCurMonth(m => m - 1);
  }
  function nextMonth() {
    if (curMonth === 11) { setCurYear(y => y + 1); setCurMonth(0); }
    else setCurMonth(m => m + 1);
  }
  function goToday() {
    setCurYear(today.getFullYear());
    setCurMonth(today.getMonth());
  }

  // ── click handlers ────────────────────────────────────────────────────────
  // Any bar or meeting opens the detail/meetings popover for its timeline.
  function handleBarClick(e, bar) {
    e.stopPropagation();
    setPopover({ tl: bar.tl, pos: { x: e.clientX, y: e.clientY } });
  }
  function handleMeetingClick(e, ms) {
    e.stopPropagation();
    setPopover({ tl: ms.tl, pos: { x: e.clientX, y: e.clientY } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-[1200px] mx-auto">

      {/* ── page header ── */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-2">
            <Icon.Calendar width={16} height={16} className="text-text-muted" />
            <h1 className="text-[14px] font-semibold text-text-primary">POV Calendar</h1>
          </div>
          <div className="text-[11px] text-text-muted mt-0.5">
            {loading ? 'Loading…' : `${timelines.length} timeline${timelines.length !== 1 ? 's' : ''} with dates`}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* view toggle */}
          <div className="flex items-center gap-1 bg-[#10141b] border border-border rounded p-0.5">
            {(['month','list']).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 rounded text-[11px] transition ${
                  view === v
                    ? 'bg-accent-blue/15 text-accent-blue border border-accent-blue/30'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>

          {/* New POV button */}
          <button
            onClick={() => navigate('/accounts')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] bg-[#58a6ff]/10 text-[#58a6ff] border border-[#58a6ff]/25 hover:bg-[#58a6ff]/20 transition"
          >
            <TablerIcon name="ti-file-plus" className="text-[12px]" />
            New POV
          </button>

          {/* Add event button */}
          <button
            onClick={() => setEventModal({ date: '' })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] bg-[#bc8cff]/10 text-[#bc8cff] border border-[#bc8cff]/25 hover:bg-[#bc8cff]/20 transition"
          >
            <TablerIcon name="ti-calendar-event" className="text-[12px]" />
            Add event
          </button>

          {/* Add timeline button */}
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] bg-[#3fb950]/10 text-[#3fb950] border border-[#3fb950]/25 hover:bg-[#3fb950]/20 transition"
          >
            <TablerIcon name="ti-calendar-plus" className="text-[12px]" />
            Add timeline
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-4 px-4 py-2 bg-accent-red/10 border border-accent-red/30 rounded text-[12px] text-accent-red">
          {err}
        </div>
      )}

      {/* ── stats row ── */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <StatCard label="Active POVs"         value={stats.activePovs}         color="text-accent-blue" />
        <StatCard label="Closing this month"  value={stats.closingThisMonth}   color="text-accent-green" />
        <StatCard label="Meetings this week" value={stats.meetingsThisWeek} color="text-accent-yellow" />
        <StatCard label="Upcoming starts"     value={stats.upcomingStarts}     color="text-accent-orange" />
      </div>

      {/* ── list view ── */}
      {view === 'list' && <ListView timelines={timelines} />}

      {/* ── month calendar ── */}
      {view === 'month' && (
        <>
          <Card className="overflow-hidden">
            {/* calendar header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Icon.Calendar width={13} height={13} className="text-text-muted" />
                <span className="text-[13px] font-semibold text-text-primary">
                  {MONTH_NAMES[curMonth]} {curYear}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={goToday}
                  className="px-2.5 py-1 rounded text-[11px] text-text-muted border border-border hover:text-text-primary hover:border-accent-blue/40 transition"
                >
                  Today
                </button>
                <button
                  onClick={prevMonth}
                  className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-[#14181f] transition"
                  aria-label="Previous month"
                >
                  <Icon.Back width={13} height={13} />
                </button>
                <button
                  onClick={nextMonth}
                  className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-[#14181f] transition"
                  style={{ transform: 'scaleX(-1)' }}
                  aria-label="Next month"
                >
                  <Icon.Back width={13} height={13} />
                </button>
              </div>
            </div>

            {/* day-of-week headers */}
            <div className="grid grid-cols-7 border-b border-border">
              {DAY_HEADERS.map((h, i) => (
                <div
                  key={h}
                  className={`text-center py-2 text-[10px] font-medium text-text-dim tracking-widest uppercase
                    ${i === 0 || i === 6 ? 'bg-app' : ''}`}
                >
                  {h}
                </div>
              ))}
            </div>

            {/* calendar grid */}
            <div className="grid grid-cols-7">
              {days.map((day, idx) => {
                const isWeekend = idx % 7 === 0 || idx % 7 === 6;
                const key       = day ? ymd(day) : `blank-${idx}`;
                const isToday   = day ? ymd(day) === todayStr : false;
                const info      = (day && dayMap[key]) || { bars: [], dots: [] };
                const isLastRow = idx >= days.length - 7;

                return (
                  <div
                    key={key}
                    onClick={day ? () => setEventModal({ date: ymd(day) }) : undefined}
                    title={day ? 'Click to add an event on this day' : undefined}
                    className={[
                      'min-h-[90px] border-b border-r border-border px-1.5 pt-1 pb-1.5 relative flex flex-col gap-0.5',
                      isWeekend ? 'bg-app' : 'bg-card',
                      day ? 'cursor-pointer hover:bg-[#11161e]' : '',
                      isLastRow ? 'border-b-0' : '',
                      idx % 7 === 6 ? 'border-r-0' : '',
                    ].join(' ')}
                  >
                    {/* day number */}
                    {day && (
                      <div className="flex items-start justify-between mb-0.5">
                        <span
                          className={[
                            'text-[11px] font-medium w-5 h-5 flex items-center justify-center rounded-full',
                            isToday
                              ? 'bg-accent-blue text-white'
                              : 'text-text-muted',
                          ].join(' ')}
                        >
                          {day.getDate()}
                        </span>
                      </div>
                    )}

                    {/* Timeline bars */}
                    {day && info.bars.slice(0, 3).map((bar, bi) => {
                      const tlTitle = bar.isManual
                        ? `${bar.tl.account_name} · ${bar.label}\n${bar.tl.start_date} – ${bar.tl.end_date}\nManually added · Click to edit`
                        : `${bar.tl.account_name} · ${bar.tl.label || 'POV'}\n${bar.tl.start_date} – ${bar.tl.end_date}\nClick to view`;

                      return (
                        <div
                          key={bi}
                          className={[
                            'flex items-center h-[14px] text-[9px] font-medium overflow-hidden cursor-pointer',
                            bar.isStart && bar.isEnd ? 'rounded' : '',
                            bar.isStart && !bar.isEnd ? 'rounded-l' : '',
                            !bar.isStart && bar.isEnd ? 'rounded-r' : '',
                          ].join(' ')}
                          style={{ background: `${bar.barColor}33`, borderLeft: bar.isStart ? `2px solid ${bar.barColor}` : 'none' }}
                          title={tlTitle}
                          onClick={e => handleBarClick(e, bar)}
                        >
                          <span
                            className="flex items-center gap-0.5 truncate pl-1 leading-none"
                            style={{ color: bar.barColor }}
                          >
                            {bar.isStart && bar.isManual && (
                              <TablerIcon name="ti-pencil" className="text-[10px] shrink-0" />
                            )}
                            {bar.label}
                          </span>
                        </div>
                      );
                    })}
                    {day && info.bars.length > 3 && (
                      <span className="text-[9px] text-text-dim pl-0.5">+{info.bars.length - 3} more</span>
                    )}

                    {/* Meeting markers — account name + meeting type, e.g. "BLG · Kick Off" */}
                    {day && info.dots.map((ms, mi) => (
                      <div
                        key={`m-${mi}`}
                        className="flex items-center gap-1 h-[13px] text-[9px] font-medium leading-none overflow-hidden cursor-pointer"
                        title={`${ms.tl.account_name || ''} · ${ms.label}`}
                        onClick={e => handleMeetingClick(e, ms)}
                      >
                        <span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ background: ms.color }} />
                        <span className="truncate" style={{ color: ms.color }}>
                          {ms.tl.account_name} · {ms.label}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* ── legend ── */}
          <div className="mt-3 flex flex-wrap items-center gap-4 px-1">
            <span className="text-[10px] text-text-dim uppercase tracking-wider">Meetings:</span>
            {MEETING_TYPES.map(mt => (
              <div key={mt.key} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: mt.color }} />
                <span className="text-[10px] text-text-dim">{mt.label}</span>
              </div>
            ))}
            <span className="text-[10px] text-text-dim ml-2">· Click a day (or “Add event”) to schedule a meeting</span>
          </div>

          {/* ── empty state ── */}
          {!loading && timelines.length === 0 && (
            <div className="mt-6 border border-dashed border-border rounded-lg py-12 text-center">
              <Icon.Calendar width={20} height={20} className="text-text-dim mx-auto mb-2" />
              <div className="text-[12px] text-text-dim">No timelines scheduled.</div>
              <div className="text-[11px] text-text-dim mt-1">Add a timeline or generate a POV to see it here.</div>
            </div>
          )}
        </>
      )}

      {/* ── modals / overlays ── */}
      {showAddModal && (
        <AddTimelineModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => { setShowAddModal(false); reload(); }}
        />
      )}

      {eventModal && (
        <AddEventModal
          timelines={timelines}
          defaultDate={eventModal.date}
          onClose={() => setEventModal(null)}
          onSuccess={() => { setEventModal(null); reload(); }}
        />
      )}

      {popover && (
        <EditPopover
          tl={popover.tl}
          pos={popover.pos}
          onClose={() => setPopover(null)}
          onReload={() => { reload(); }}
        />
      )}
    </div>
  );
}

// ─── List View ───────────────────────────────────────────────────────────────
// Flat list of every POV with status, date range, and its scheduled meetings.

function ListView({ timelines }) {
  if (!timelines.length) {
    return (
      <Card>
        <div className="py-12 text-center text-[12px] text-text-dim">No POVs scheduled.</div>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {timelines.map(tl => {
        const meetings = (tl.meetings || []).slice().sort((a, b) => a.meeting_date.localeCompare(b.meeting_date));
        return (
          <Card key={tl.id} className="overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: tl.account_color || '#378ADD' }} />
              <Link to={`/accounts/${tl.account_id}`} className="text-[13px] font-medium text-text-primary hover:text-accent-blue truncate">
                {tl.account_name}
              </Link>
              {tl.label && <span className="text-[11px] text-text-muted truncate">· {tl.label}</span>}
              <span className="ml-auto text-[11px] text-text-muted shrink-0">
                {formatDate(tl.start_date)} – {formatDate(tl.end_date)}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 font-medium ${statusClass(tl.status)}`}>
                {tl.status || 'Draft'}
              </span>
            </div>
            <div className="px-4 py-2.5">
              {meetings.length === 0 ? (
                <div className="text-[11px] text-text-dim">No meetings scheduled.</div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {meetings.map(m => {
                    const def = MEETING_BY_KEY[m.type] || { label: m.type, color: '#8b949e' };
                    return (
                      <div key={m.id} className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: def.color }} />
                        <span className="text-[11px] font-medium w-24 shrink-0" style={{ color: def.color }}>{def.label}</span>
                        <span className="text-[11px] text-text-muted">{formatDate(m.meeting_date)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─── StatCard ────────────────────────────────────────────────────────────────

function StatCard({ label, value, color }) {
  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3 flex flex-col gap-1">
      <div className={`text-[20px] font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[10px] text-text-dim">{label}</div>
    </div>
  );
}
