import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icons.jsx';
import { api } from '../lib/api.js';

// Human label per FTS source_type (see server/db/database.js triggers).
const TYPE_LABEL = {
  account: 'Account',
  note: 'Note',
  transcript: 'Transcript',
  contact: 'Contact',
  deal: 'Deal',
  file: 'File',
  attachment: 'File'
};

// Escape HTML from indexed content, then re-allow only the <mark> tags the FTS
// snippet() adds — note/transcript bodies are user content, so we must not
// render arbitrary HTML from them.
function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderSnippet(s) {
  if (!s) return '';
  // Escape everything, then re-allow only the <mark> tags FTS snippet() adds.
  return escapeHtml(s).replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}

// Global search bar. Queries the FTS index (/api/search) as the user types and
// shows results grouped by account in a dropdown; selecting a result opens that
// account. forwardRef exposes focus() so the "/" shortcut in Layout works.
const GlobalSearch = forwardRef(function GlobalSearch(_props, ref) {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  // Debounced search. A request token guards against out-of-order responses so
  // a slow earlier query can't overwrite a faster later one.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const rows = await api.search(q);
        if (!cancelled) { setResults(Array.isArray(rows) ? rows : []); setActive(0); }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  // Collapse hits into one entry per account, preserving rank order and keeping
  // the top few matched snippets for context.
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of results) {
      const key = r.account_id || `orphan:${r.source_type}:${r.source_id}`;
      if (!map.has(key)) {
        map.set(key, { accountId: r.account_id, accountName: r.account_name, hits: [] });
      }
      map.get(key).hits.push(r);
    }
    return Array.from(map.values());
  }, [results]);

  const showDropdown = open && query.trim().length >= 2;

  function go(group) {
    if (!group?.accountId) return;
    setOpen(false);
    inputRef.current?.blur();
    navigate(`/accounts/${group.accountId}`);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (open) { setOpen(false); } else { inputRef.current?.blur(); }
      return;
    }
    if (e.key === 'Enter') {
      if (groups.length) { e.preventDefault(); go(groups[Math.min(active, groups.length - 1)]); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setOpen(true);
      setActive(a => Math.min(a + 1, Math.max(groups.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(a => Math.max(a - 1, 0));
    }
  }

  // Close when clicking outside the search area.
  useEffect(() => {
    function onDocMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  return (
    <div ref={containerRef} className="flex-1 max-w-xl relative">
      <Icon.Search width={13} height={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder='Search accounts, notes, people…   press  /'
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="w-full bg-[#0a0d11] border border-border rounded pl-8 pr-3 py-1.5 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50"
      />

      {showDropdown && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-xl overflow-hidden">
          {loading && groups.length === 0 && (
            <div className="px-3 py-3 text-[12px] text-text-dim">Searching…</div>
          )}
          {!loading && groups.length === 0 && (
            <div className="px-3 py-3 text-[12px] text-text-dim">
              No matches for “{query.trim()}”.
            </div>
          )}
          {groups.length > 0 && (
            <div className="max-h-[60vh] overflow-auto py-1">
              {groups.map((g, i) => (
                <button
                  key={g.accountId || i}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(g)}
                  className={`w-full text-left px-3 py-2 border-l-2 transition ${
                    i === active
                      ? 'bg-[#11161e] border-accent-blue'
                      : 'border-transparent hover:bg-[#11161e]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Icon.Folder width={12} height={12} className="text-text-dim shrink-0" />
                    <span className="text-[12px] font-medium text-text-primary truncate">
                      {g.accountName || 'Unknown account'}
                    </span>
                    <span className="ml-auto text-[10px] text-text-dim shrink-0">
                      {g.hits.length} match{g.hits.length === 1 ? '' : 'es'}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-col gap-0.5 pl-[18px]">
                    {g.hits.slice(0, 3).map((h, j) => (
                      <div key={j} className="flex items-baseline gap-1.5 min-w-0">
                        <span className="text-[10px] uppercase tracking-wide text-text-dim shrink-0 w-[64px]">
                          {TYPE_LABEL[h.source_type] || h.source_type}
                        </span>
                        <span
                          className="text-[11px] text-text-muted truncate"
                          dangerouslySetInnerHTML={{ __html: renderSnippet(h.snippet) || escapeHtml(h.title) }}
                        />
                      </div>
                    ))}
                    {g.hits.length > 3 && (
                      <span className="text-[10px] text-text-dim pl-[70px]">+{g.hits.length - 3} more</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default GlobalSearch;
