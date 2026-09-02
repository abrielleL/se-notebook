import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import TablerIcon from './TablerIcon.jsx';
import { SNOOZE_OPTIONS } from '../lib/constants.js';

const PANEL_MARGIN = 8;

// Snooze control: a button that opens a window picker, or an "unsnooze" button
// when the account is already snoozed.
//
// Two things this has to work around:
//
//  1. The dashboard's stage columns are `overflow-y-auto` with a 60vh cap, so
//     an absolutely-positioned menu gets clipped by its own column — badly in
//     a short column (a stage holding one card clipped almost all of it). The
//     panel is therefore rendered in a portal on document.body and positioned
//     with fixed coordinates from the button's rect.
//  2. Dashboard cards reveal this control on hover. If the caller wraps it in
//     `opacity-0 group-hover:opacity-100`, then walking the pointer to the open
//     menu leaves the card and blanks the menu mid-click. So the hover reveal
//     lives in here instead (`revealOnHover`), where it can be overridden while
//     the menu is open.
//
// Cards are <Link>s, so every handler stops propagation and prevents the
// default — snoozing must never navigate to the account.
export default function SnoozeMenu({
  account,
  onSnooze,
  onUnsnooze,
  compact = false,
  revealOnHover = false
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [reason, setReason] = useState('');
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

  const close = () => { setOpen(false); setPos(null); setReason(''); };

  // Position against the button, flipping above it when there's no room below
  // and clamping to the viewport so the panel is never half off-screen.
  useLayoutEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    const panel = panelRef.current;
    if (!btn || !panel) return;

    const r = btn.getBoundingClientRect();
    const { offsetHeight: h, offsetWidth: w } = panel;

    let top = r.bottom + 4;
    if (top + h > window.innerHeight - PANEL_MARGIN) {
      top = Math.max(PANEL_MARGIN, r.top - 4 - h);
    }
    let left = r.right - w;   // right-aligned to the button
    left = Math.min(left, window.innerWidth - w - PANEL_MARGIN);
    left = Math.max(PANEL_MARGIN, left);

    setPos({ top, left });
  }, [open]);

  // Outside click has to consider the portal too: the panel is not a DOM
  // descendant of this component, so a click on the reason input would
  // otherwise read as "outside" and close the menu.
  useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      if (btnRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      close();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    // Fixed coordinates detach from the button once anything scrolls, so close
    // rather than drift. Capture, to catch the scrolling stage column itself.
    function onScroll() { close(); }

    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // A snoozed account always shows its way back; an open menu stays visible.
  const hidden = revealOnHover && !open && !account.is_snoozed;
  const btnCls = `flex items-center gap-1 text-[10px] shrink-0 transition ${
    hidden ? 'opacity-0 group-hover:opacity-100' : ''
  }`;

  if (account.is_snoozed) {
    return (
      <button
        ref={btnRef}
        onClick={(e) => { stop(e); onUnsnooze(); }}
        title={snoozeTitle(account)}
        className={`${btnCls} text-text-dim hover:text-accent-blue`}
      >
        <TablerIcon name="ti-zzz" />
        {!compact && <span>Unsnooze</span>}
      </button>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { stop(e); setOpen(o => !o); }}
        title="Snooze — hide from the stage board"
        className={`${btnCls} ${open ? 'text-accent-blue' : 'text-text-dim hover:text-accent-blue'}`}
      >
        <TablerIcon name="ti-zzz" />
        {!compact && <span>Snooze</span>}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          onClick={stop}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: pos ? pos.top : -9999,
            left: pos ? pos.left : -9999,
            // Hidden for the one layout pass before the panel is measured, so
            // it never flashes in the wrong place.
            visibility: pos ? 'visible' : 'hidden'
          }}
          className="z-[100] w-[230px] bg-card border border-border rounded-lg shadow-xl py-1"
        >
          <div className="px-3 py-1.5 text-[10px] text-text-dim border-b border-border">
            Hide {account.account_name} from the stage board
          </div>

          {/* Reason first, so the flow reads top-to-bottom: why, then how long.
              Picking a window is the commit, so it has to come last. */}
          <div className="px-2 py-1.5">
            <input
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Why? (optional)"
              className="w-full bg-[#040d1c] border border-border rounded px-2 py-1 text-[11px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50"
            />
          </div>

          <div className="border-t border-border pt-1">
            {SNOOZE_OPTIONS.map(o => (
              <button
                key={o.label}
                onClick={(e) => {
                  stop(e);
                  const r = reason.trim();
                  close();
                  onSnooze({ days: o.days, reason: r });
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-[#111f42] transition"
              >
                <span className="text-[11px] text-text-primary">{o.label}</span>
                <span className="text-[10px] text-text-dim">{o.hint}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
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
