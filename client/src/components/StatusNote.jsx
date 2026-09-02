import { useEffect, useRef, useState } from 'react';
import TablerIcon from './TablerIcon.jsx';

// The account's "what's going on right now" note: a hand-written line or two
// pinned to the top of the account page — why it's parked, who we're waiting
// on, what to say if it comes up.
//
// Click to edit, save on blur. Cmd/Ctrl+Enter saves and closes, Escape
// reverts. Deliberately NOT markdown-rendered: this is a user-typed note, so
// per the project convention it stays raw (whitespace preserved so short
// bullet-ish lines survive).
export default function StatusNote({ value, updatedAt, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  // Guards the blur handler when Escape closes the editor, so reverting
  // doesn't immediately get saved by the blur that follows.
  const cancelled = useRef(false);

  // Re-seed when the account changes underneath us (navigation, refetch).
  useEffect(() => { if (!editing) setDraft(value || ''); }, [value, editing]);

  useEffect(() => {
    if (!editing || !ref.current) return;
    ref.current.focus();
    const len = ref.current.value.length;
    ref.current.setSelectionRange(len, len);
  }, [editing]);

  async function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next === (value || '').trim()) return;   // nothing changed
    setSaving(true);
    await onSave(next);
    setSaving(false);
  }

  function onBlur() {
    if (cancelled.current) { cancelled.current = false; return; }
    commit();
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

  return (
    <div className="px-5 py-2.5 border-b border-border bg-[#040d1c]/40">
      <div className="flex items-start gap-2.5">
        <TablerIcon name="ti-pin" className="text-text-muted mt-0.5 shrink-0" />

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wide text-text-dim">Status</span>
            {updatedAt && !editing && (
              <span className="text-[10px] text-text-dim">updated {timeAgo(updatedAt)}</span>
            )}
            {saving && <span className="text-[10px] text-text-dim">saving…</span>}
            {editing && (
              <span className="text-[10px] text-text-dim">
                {navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'}Enter to save · Esc to cancel
              </span>
            )}
          </div>

          {editing ? (
            <textarea
              ref={ref}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={onBlur}
              onKeyDown={onKeyDown}
              rows={3}
              placeholder="What's happening with this account right now?"
              className="w-full bg-[#040d1c] border border-accent-blue/40 rounded px-2.5 py-1.5 text-[12px] text-text-primary placeholder-text-dim leading-relaxed focus:outline-none resize-y"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Click to edit"
              className="w-full text-left group"
            >
              {hasNote ? (
                // whitespace-pre-wrap: raw text, but line breaks the SE typed
                // are the structure, so they have to survive.
                <span className="block text-[12px] text-text-secondary leading-relaxed whitespace-pre-wrap group-hover:text-text-primary transition">
                  {value}
                </span>
              ) : (
                <span className="block text-[12px] text-text-dim italic group-hover:text-text-muted transition">
                  Add a status note — why it's parked, what you're waiting on, where it stands.
                </span>
              )}
            </button>
          )}
        </div>

        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-text-dim hover:text-accent-blue shrink-0 mt-0.5"
            title={hasNote ? 'Edit status note' : 'Add status note'}
          >
            <TablerIcon name={hasNote ? 'ti-pencil' : 'ti-plus'} />
          </button>
        )}
      </div>
    </div>
  );
}

// Coarse relative time — this only ever labels a note someone typed, so
// day-level precision is plenty.
function timeAgo(ts) {
  const then = new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
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
