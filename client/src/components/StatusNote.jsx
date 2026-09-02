import { useEffect, useRef, useState } from 'react';
import TablerIcon from './TablerIcon.jsx';

const COLLAPSED_H = 32;   // one line, sized to sit level with the header buttons
const EXPANDED_H = 96;    // ~4 lines once you're actually typing

// The account's status note: a text box in the account header, next to Snooze,
// for "what's going on right now" — why it's parked, who we're waiting on.
//
// Never written by AI. The extraction path only ever sends the four ai_* keys,
// and the API accepts status_note through its own explicit branch, so nothing
// in the summary pipeline can reach this field.
//
// It lives in a fixed-height slot so the header never reflows: collapsed it's
// a one-line box, and clicking swaps in a taller textarea that overlays the
// stage bar below. Collapsed has to be a div rather than a short textarea —
// a textarea still line-breaks on \n regardless of white-space, so a
// multi-line note bled past the bottom border.
export default function StatusNote({ value, updatedAt, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  // Set when Escape reverts, so the blur that follows doesn't re-save the
  // text we just threw away.
  const cancelled = useRef(false);

  // Re-seed when the account changes underneath us (navigation, refetch),
  // but never while the user is mid-edit.
  useEffect(() => { if (!editing) setDraft(value || ''); }, [value, editing]);

  useEffect(() => {
    if (!editing || !ref.current) return;
    ref.current.focus();
    const len = ref.current.value.length;
    ref.current.setSelectionRange(len, len);
  }, [editing]);

  async function commit() {
    setEditing(false);
    if (cancelled.current) { cancelled.current = false; return; }
    const next = draft.trim();
    if (next === (value || '').trim()) return;   // nothing actually changed
    setSaving(true);
    await onSave(next);
    setSaving(false);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelled.current = true;
      setDraft(value || '');
      setEditing(false);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  }

  const hasNote = (value || '').trim() !== '';
  // Collapsed, the whole note is folded onto one line so a multi-line note
  // still reads as more than just its first sentence.
  const oneLine = hasNote ? value.split('\n').map(s => s.trim()).filter(Boolean).join(' · ') : '';
  const tooltip = hasNote
    ? (updatedAt ? `${value}\n\n(updated ${timeAgo(updatedAt)})` : value)
    : "Status note — why it's parked, what you're waiting on. Never touched by AI.";

  return (
    <div className="relative flex-1 min-w-0 max-w-[460px]" style={{ height: COLLAPSED_H }}>
      {editing ? (
        <div className="absolute left-0 top-0 w-full z-40">
          <div className="relative">
            <TablerIcon name="ti-pin" className="absolute left-2 top-[9px] text-text-muted pointer-events-none z-10" />
            <textarea
              ref={ref}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={onKeyDown}
              placeholder="What's happening with this account right now?"
              className="w-full bg-[#040d1c] border border-accent-blue/50 rounded-t pl-7 pr-2 py-1.5 text-[12px] text-text-primary placeholder-text-dim leading-[1.35] resize-none focus:outline-none shadow-2xl"
              style={{ height: EXPANDED_H }}
            />
          </div>
          <div className="flex items-center justify-between gap-2 bg-card border border-t-0 border-accent-blue/50 rounded-b px-2 py-1 shadow-2xl">
            <span className="text-[10px] text-text-dim">
              {isMac() ? '⌘' : 'Ctrl+'}Enter to save · Esc to cancel
            </span>
            {updatedAt && <span className="text-[10px] text-text-dim shrink-0">updated {timeAgo(updatedAt)}</span>}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title={tooltip}
          className="w-full h-full flex items-center gap-2 bg-[#040d1c] border border-border hover:border-text-dim rounded pl-7 pr-2 text-left relative transition-colors group"
        >
          <TablerIcon
            name="ti-pin"
            className={`absolute left-2 ${hasNote ? 'text-text-muted' : 'text-text-dim'}`}
          />
          <span className={`flex-1 min-w-0 truncate text-[12px] ${
            hasNote ? 'text-text-secondary group-hover:text-text-primary' : 'text-text-dim'
          }`}>
            {hasNote ? oneLine : 'Status note…'}
          </span>
          {saving
            ? <span className="shrink-0 text-[10px] text-text-dim">saving…</span>
            : hasNote && updatedAt && <span className="shrink-0 text-[10px] text-text-dim">{timeAgo(updatedAt)}</span>}
        </button>
      )}
    </div>
  );
}

const isMac = () => typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');

// Coarse relative time — this only ever labels a note someone typed by hand,
// so day-level precision is plenty.
function timeAgo(ts) {
  if (!ts) return '';
  const raw = String(ts);
  // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC with no zone
  // marker; ISO strings from the API already carry one.
  const then = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(then.getTime())) return '';
  const mins = Math.floor((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months}mo ago`;
}
