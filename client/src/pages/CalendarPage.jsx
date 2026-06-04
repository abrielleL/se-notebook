import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { api } from '../lib/api.js';
import Card, { CardHeader } from '../components/Card.jsx';
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

// ─── milestone helpers ───────────────────────────────────────────────────────

const MILESTONE_TYPES = [
  { key: 'kickoff',   label: 'Kickoff',          color: '#58a6ff', offset: 0,  fromEnd: false },
  { key: 'midpov',    label: 'Mid-POV',           color: '#e3b341', offset: 7,  fromEnd: false },
  { key: 'closeout',  label: 'Close-out',         color: '#3fb950', offset: 0,  fromEnd: true  },
  { key: 'prereq',    label: 'Prereq deadline',   color: '#f85149', offset: -1, fromEnd: false },
];

function getMilestonesForTimeline(tl) {
  const start = parseLocal(tl.start_date);
  const end   = parseLocal(tl.end_date);
  const ms = [];
  for (const mt of MILESTONE_TYPES) {
    let base = mt.fromEnd ? end : start;
    if (!base) continue;
    const date = addDays(base, mt.offset);
    ms.push({ ...mt, date, tl });
  }
  return ms;
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

// ─── Edit Popover (for manually_created bars) ────────────────────────────────

function EditPopover({ tl, pos, onClose, onReload }) {
  const toast = useToast();
  const ref   = useRef(null);
  const [label, setLabel]     = useState(tl.label || '');
  const [startStr, setStart]  = useState(tl.start_date || '');
  const [endStr, setEnd]      = useState(tl.end_date || '');
  const [status, setStatus]   = useState(tl.status || 'Draft');
  const [dateErr, setDateErr] = useState('');
  const [saving, setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  // close on outside click
  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // close on Escape
  useEffect(() => {
    function handler(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // clamp position to viewport
  const style = useMemo(() => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const popW = 280;
    const popH = 340;
    let x = pos.x + 8;
    let y = pos.y + 8;
    if (x + popW > W - 8) x = W - popW - 8;
    if (y + popH > H - 8) y = H - popH - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    return { position: 'fixed', left: x, top: y, width: popW, zIndex: 50 };
  }, [pos]);

  async function handleSave() {
    if (!startStr || !endStr) { setDateErr('Start and end dates are required'); return; }
    const s = parseLocal(startStr);
    const e = parseLocal(endStr);
    if (!s || !e || e <= s) { setDateErr('End date must be after start date'); return; }
    setDateErr('');
    setSaving(true);
    try {
      await api.updateTimeline(tl.id, { label, start_date: startStr, end_date: endStr, status });
      onReload();
      onClose();
    } catch (err) {
      toast(err.message || 'Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.deleteTimeline(tl.id);
      onReload();
      onClose();
    } catch (err) {
      toast(err.message || 'Failed to delete', 'error');
      setDeleting(false);
    }
  }

  return (
    <div
      ref={ref}
      style={style}
      className="bg-[#0d1117] border border-[#1e2530] rounded-lg shadow-lg p-3 flex flex-col gap-2.5"
    >
      <div className="text-[11px] font-semibold text-[#e6edf3] mb-0.5">Edit timeline</div>

      {/* Label */}
      <div className="flex flex-col gap-1">
        <label className="text-[9px] font-medium text-[#8b949e] uppercase tracking-wider">Label</label>
        <input
          className={inputCls}
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Timeline label"
        />
      </div>

      {/* Start date */}
      <div className="flex flex-col gap-1">
        <label className="text-[9px] font-medium text-[#8b949e] uppercase tracking-wider">Start date</label>
        <DatePicker
          selected={parseISODate(startStr)}
          onChange={d => setStart(toISODate(d))}
          dateFormat="MMM d, yyyy"
          placeholderText="Select date"
          className={inputCls}
          popperPlacement="bottom-start"
        />
      </div>

      {/* End date */}
      <div className="flex flex-col gap-1">
        <label className="text-[9px] font-medium text-[#8b949e] uppercase tracking-wider">End date</label>
        <DatePicker
          selected={parseISODate(endStr)}
          onChange={d => setEnd(toISODate(d))}
          dateFormat="MMM d, yyyy"
          placeholderText="Select date"
          className={inputCls}
          popperPlacement="bottom-start"
        />
      </div>

      {/* Status */}
      <div className="flex flex-col gap-1">
        <label className="text-[9px] font-medium text-[#8b949e] uppercase tracking-wider">Status</label>
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

      {dateErr && (
        <div className="text-[10px] text-[#f85149]">{dateErr}</div>
      )}

      {/* Delete confirm */}
      {confirmDel ? (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-[#1e2530]">
          <div className="text-[10px] text-[#f85149]">Remove from calendar?</div>
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-2 py-1 rounded text-[10px] bg-[#f85149]/15 text-[#f85149] border border-[#f85149]/30 hover:bg-[#f85149]/25 transition disabled:opacity-40"
            >
              {deleting ? 'Deleting…' : 'Yes'}
            </button>
            <button
              onClick={() => setConfirmDel(false)}
              className="px-2 py-1 rounded text-[10px] text-[#8b949e] border border-[#1e2530] hover:text-[#e6edf3] transition"
            >
              No
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between pt-1 border-t border-[#1e2530]">
          <button
            onClick={() => setConfirmDel(true)}
            className="px-2 py-1 rounded text-[10px] text-[#f85149] border border-[#f85149]/20 hover:bg-[#f85149]/10 transition"
          >
            Delete
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-2.5 py-1 rounded text-[10px] bg-[#58a6ff]/15 text-[#58a6ff] border border-[#58a6ff]/30 hover:bg-[#58a6ff]/25 transition disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
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

  // ── derived: all milestones ───────────────────────────────────────────────
  const allMilestones = useMemo(() => {
    const ms = [];
    timelines.forEach(tl => ms.push(...getMilestonesForTimeline(tl)));
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
    const milestonesThisWeek = allMilestones.filter(ms =>
      ms.date >= today && ms.date <= weekEnd
    ).length;

    const upcomingStarts = timelines.filter(t => {
      if (!t.start_date) return false;
      return parseLocal(t.start_date) > today;
    }).length;

    return { activePovs, closingThisMonth, milestonesThisWeek, upcomingStarts };
  }, [timelines, allMilestones, curYear, curMonth, today]);

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

    // milestone dots
    allMilestones.forEach(ms => {
      const key = ymd(ms.date);
      ensure(key);
      map[key].dots.push(ms);
    });

    return map;
  }, [timelines, allMilestones]);

  // ── "this week" panel ─────────────────────────────────────────────────────
  const weekMilestones = useMemo(() => {
    const weekEnd = addDays(today, 7);
    return allMilestones
      .filter(ms => ms.date <= weekEnd)
      .sort((a, b) => a.date - b.date);
  }, [allMilestones, today]);

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

  // ── bar click handler ─────────────────────────────────────────────────────
  function handleBarClick(e, bar) {
    e.stopPropagation();
    if (bar.isManual) {
      setPopover({ tl: bar.tl, pos: { x: e.clientX, y: e.clientY } });
    } else {
      navigate('/accounts/' + bar.tl.account_id);
    }
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
            {(['month','quarter','list']).map(v => (
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
        <StatCard label="Milestones this week" value={stats.milestonesThisWeek} color="text-accent-yellow" />
        <StatCard label="Upcoming starts"     value={stats.upcomingStarts}     color="text-accent-orange" />
      </div>

      {/* ── non-month views stub ── */}
      {view !== 'month' && (
        <Card>
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <Icon.Calendar width={24} height={24} className="text-text-dim" />
            <div className="text-[12px] text-text-muted">
              {view.charAt(0).toUpperCase() + view.slice(1)} view — coming soon
            </div>
            <button
              onClick={() => setView('month')}
              className="mt-2 px-3 py-1.5 rounded text-[11px] bg-accent-blue/10 text-accent-blue border border-accent-blue/25 hover:bg-accent-blue/20 transition"
            >
              Back to Month
            </button>
          </div>
        </Card>
      )}

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
                    className={[
                      'min-h-[90px] border-b border-r border-border px-1.5 pt-1 pb-1.5 relative flex flex-col gap-0.5',
                      isWeekend ? 'bg-app' : 'bg-card',
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
                        {/* dots row */}
                        {info.dots.length > 0 && (
                          <div className="flex gap-0.5 flex-wrap justify-end mt-0.5">
                            {info.dots.map((ms, di) => (
                              <span
                                key={di}
                                className="w-[5px] h-[5px] rounded-full shrink-0"
                                style={{ background: ms.color }}
                                title={`${ms.label}: ${ms.tl.account_name || ''}`}
                              />
                            ))}
                          </div>
                        )}
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
                          {bar.isStart && (
                            <span
                              className="flex items-center gap-0.5 truncate pl-1 leading-none"
                              style={{ color: bar.barColor }}
                            >
                              {bar.isManual && (
                                <TablerIcon name="ti-pencil" className="text-[10px] shrink-0" />
                              )}
                              {bar.label}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {day && info.bars.length > 3 && (
                      <span className="text-[9px] text-text-dim pl-0.5">+{info.bars.length - 3} more</span>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* ── legend ── */}
          <div className="mt-3 flex flex-wrap gap-4 px-1">
            {MILESTONE_TYPES.map(mt => (
              <div key={mt.key} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: mt.color }} />
                <span className="text-[10px] text-text-dim">{mt.label}</span>
              </div>
            ))}
          </div>

          {/* ── this week panel ── */}
          <div className="mt-5">
            <Card>
              <CardHeader
                title="This Week"
                subtitle="Milestones in the next 7 days"
                icon={Icon.Calendar}
              />
              {weekMilestones.length === 0 ? (
                <div className="px-4 py-8 text-center text-[12px] text-text-dim">
                  No milestones in the next 7 days.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {weekMilestones.map((ms, i) => {
                    const msDate    = ymd(ms.date);
                    const isOverdue = ms.date < today && msDate !== todayStr;
                    return (
                      <div
                        key={i}
                        onClick={() => navigate(`/accounts/${ms.tl.account_id}`)}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#14181f] cursor-pointer transition"
                      >
                        {/* colored dot */}
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: ms.color }}
                        />

                        {/* milestone label */}
                        <span className="text-[11px] text-text-secondary w-28 shrink-0">{ms.label}</span>

                        {/* account name */}
                        <span className="text-[11px] text-accent-blue flex-1 truncate">
                          {ms.tl.account_name || '—'}
                        </span>

                        {/* date */}
                        <span className="text-[11px] text-text-muted shrink-0">
                          {formatDate(msDate)}
                        </span>

                        {/* urgency badge */}
                        <span
                          className={[
                            'text-[10px] px-1.5 py-0.5 rounded border shrink-0',
                            isOverdue
                              ? 'bg-accent-red/10 text-accent-red border-accent-red/30'
                              : msDate === todayStr
                              ? 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/30'
                              : 'bg-[#10141b] text-text-dim border-border',
                          ].join(' ')}
                        >
                          {isOverdue ? 'Overdue' : msDate === todayStr ? 'Today' : 'Upcoming'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
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

// ─── StatCard ────────────────────────────────────────────────────────────────

function StatCard({ label, value, color }) {
  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3 flex flex-col gap-1">
      <div className={`text-[20px] font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[10px] text-text-dim">{label}</div>
    </div>
  );
}
