import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icons.jsx';

// Chips for the accounts on the other end of a partner link, plus a searchable
// picker. Used from both sides of the same relation: a customer account picks
// its partners, a partner account picks the accounts it works. `linked` is the
// current list ({ id, account_name }); onChange receives the new id array.
//
// The candidate list can run to dozens of accounts, so the dropdown filters as
// you type rather than showing everything at once (the tag picker's approach,
// which only ever has a handful of options).
export default function AccountLinkEditor({
  linked = [],
  candidates = [],
  onChange,
  addLabel = 'Link account',
  emptyHint = 'None linked yet.',
  color = '#4fd15c',
  disabled = false
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  const linkedIds = useMemo(() => new Set(linked.map(l => l.id)), [linked]);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setQuery(''); } }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates
      .filter(c => !linkedIds.has(c.id))
      .filter(c => !q || (c.account_name || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [candidates, linkedIds, query]);

  function add(id) {
    onChange([...linked.map(l => l.id), id]);
    setQuery('');
    setOpen(false);
  }
  function remove(id) {
    onChange(linked.filter(l => l.id !== id).map(l => l.id));
  }

  return (
    <div ref={ref}>
      <div className="flex flex-wrap items-center gap-1.5">
        {linked.length === 0 && <span className="text-[10px] text-text-dim">{emptyHint}</span>}
        {linked.map(l => (
          <span key={l.id} className="inline-flex items-center gap-1 text-[10px] pl-2 pr-1.5 py-0.5 rounded-full font-medium"
            style={{ color, background: `${color}1f`, border: `1px solid ${color}59` }}>
            {/* The chip links through to the account -- the whole point of the
                relation is jumping between the two sides. */}
            <Link to={`/accounts/${l.id}`} className="hover:underline truncate max-w-[150px]">{l.account_name}</Link>
            {!disabled && (
              <button onClick={() => remove(l.id)} className="opacity-60 hover:opacity-100" title="Remove link">
                <Icon.X width={9} height={9} />
              </button>
            )}
          </span>
        ))}

        {!disabled && (
          <div className="relative">
            <button onClick={() => setOpen(o => !o)}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-dashed border-border text-text-dim hover:text-accent-blue hover:border-accent-blue/50 transition">
              <Icon.Plus width={9} height={9} /> {addLabel}
            </button>
            {open && (
              <div className="absolute left-0 top-full mt-1 z-50 w-[230px] bg-card border border-border rounded-lg shadow-xl py-1">
                <input
                  ref={inputRef}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search accounts"
                  className="w-[calc(100%-1rem)] mx-2 mb-1 bg-[#040d1c] border border-border rounded px-2 py-1 text-[11px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50"
                />
                <div className="max-h-52 overflow-auto">
                  {matches.length === 0 ? (
                    <div className="px-3 py-2 text-[10px] text-text-dim">
                      {candidates.length === 0
                        ? <>Nothing to link yet. <Link to="/new" className="text-accent-blue underline">Create one</Link>.</>
                        : 'No matches.'}
                    </div>
                  ) : matches.map(c => (
                    <button key={c.id} onClick={() => add(c.id)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#111f42] transition">
                      <span className="text-[11px] text-text-primary flex-1 truncate">{c.account_name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
