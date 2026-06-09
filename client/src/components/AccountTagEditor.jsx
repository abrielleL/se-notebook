import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icons.jsx';

// Inline tag chips + a picker dropdown sourced from the managed catalog.
// `tags` is an array of labels; onChange receives the new array to persist.
export default function AccountTagEditor({ tags = [], catalog = [], onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const byLabel = useMemo(() => Object.fromEntries(catalog.map(t => [t.label, t])), [catalog]);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function toggle(label) {
    onChange(tags.includes(label) ? tags.filter(t => t !== label) : [...tags, label]);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" ref={ref}>
      {tags.map(label => {
        const color = byLabel[label]?.color || '#8b949e';
        return (
          <span key={label} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium"
            style={{ color, background: `${color}22`, border: `1px solid ${color}55` }}>
            {label}
            <button onClick={() => toggle(label)} className="opacity-60 hover:opacity-100" title="Remove tag">
              <Icon.X width={9} height={9} />
            </button>
          </span>
        );
      })}

      <div className="relative">
        <button onClick={() => setOpen(o => !o)}
          className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-dashed border-border text-text-dim hover:text-accent-blue hover:border-accent-blue/50 transition">
          <Icon.Plus width={9} height={9} /> Tag
        </button>
        {open && (
          <div className="absolute left-0 top-full mt-1 z-50 min-w-[180px] bg-card border border-border rounded-lg shadow-xl py-1">
            {catalog.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-text-dim">
                No tags yet. Add some in <Link to="/settings" className="text-accent-blue underline">Settings</Link>.
              </div>
            ) : catalog.map(t => {
              const active = tags.includes(t.label);
              return (
                <button key={t.id} onClick={() => toggle(t.label)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#11161e] transition">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: t.color }} />
                  <span className="text-[11px] text-text-primary flex-1 truncate">{t.label}</span>
                  {active && <Icon.Check width={11} height={11} className="text-accent-green shrink-0" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
