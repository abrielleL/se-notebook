import { useEffect, useRef, useState } from 'react';
import TablerIcon from './TablerIcon.jsx';
import { SNOOZE_OPTIONS } from '../lib/constants.js';

// Snooze control: a small button that opens a window picker, or an "unsnooze"
// button when the account is already snoozed.
//
// Dashboard cards are <Link>s, so every handler in here stops propagation and
// prevents the default -- clicking snooze must not navigate to the account.
export default function SnoozeMenu({ account, onSnooze, onUnsnooze, compact = false }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setReason(''); } }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

  if (account.is_snoozed) {
    return (
      <button
        onClick={(e) => { stop(e); onUnsnooze(); }}
        title={snoozeTitle(account)}
        className="flex items-center gap-1 text-[10px] text-text-dim hover:text-accent-blue shrink-0 transition"
      >
        <TablerIcon name="ti-zzz" />
        {!compact && <span>Unsnooze</span>}
      </button>
    );
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={(e) => { stop(e); setOpen(o => !o); }}
        title="Snooze — hide from the stage board"
        className="flex items-center gap-1 text-[10px] text-text-dim hover:text-accent-blue transition"
      >
        <TablerIcon name="ti-zzz" />
        {!compact && <span>Snooze</span>}
      </button>
      {open && (
        <div
          onClick={stop}
          className="absolute right-0 top-full mt-1 z-50 w-[210px] bg-card border border-border rounded-lg shadow-xl py-1"
        >
          <div className="px-3 py-1.5 text-[10px] text-text-dim border-b border-border">
            Hide from the stage board
          </div>
          {SNOOZE_OPTIONS.map(o => (
            <button
              key={o.label}
              onClick={(e) => { stop(e); setOpen(false); onSnooze({ days: o.days, reason: reason.trim() }); setReason(''); }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-[#111f42] transition"
            >
              <span className="text-[11px] text-text-primary">{o.label}</span>
              <span className="text-[10px] text-text-dim">{o.hint}</span>
            </button>
          ))}
          <div className="px-2 pt-1.5 pb-1 border-t border-border mt-1">
            <input
              value={reason}
              onChange={e => setReason(e.target.value)}
              onClick={stop}
              placeholder="Why? (optional)"
              className="w-full bg-[#040d1c] border border-border rounded px-2 py-1 text-[11px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Tooltip for a snoozed account: when it comes back, and why it went away.
export function snoozeTitle(account) {
  if (!account?.is_snoozed) return '';
  const until = account.snoozed_until
    ? `Snoozed until ${account.snoozed_until}`
    : 'Snoozed indefinitely';
  return account.snooze_reason ? `${until} — ${account.snooze_reason}` : until;
}
