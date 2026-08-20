import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { initials, colorForName } from '../lib/stage.js';
import { agingColor } from '../lib/constants.js';
import { stageBadgeClass } from '../lib/stages.js';
import { useAccountUpdates } from '../lib/accountStore.js';

export default function Accounts() {
  const [accounts, setAccounts] = useState([]);
  const [tagCatalog, setTagCatalog] = useState([]);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || '');
  const [aeFilter, setAeFilter] = useState('All');
  const [tagFilter, setTagFilter] = useState('All');

  useEffect(() => { api.listAccounts().then(setAccounts); }, []);
  useEffect(() => { api.listTags().then(setTagCatalog).catch(() => {}); }, []);

  const tagColor = useMemo(() => Object.fromEntries(tagCatalog.map(t => [t.label, t.color])), [tagCatalog]);
  const inactiveLabels = useMemo(() => new Set(tagCatalog.filter(t => t.is_inactive).map(t => t.label)), [tagCatalog]);
  const isInactive = (a) => (a.tags || []).some(t => inactiveLabels.has(t));

  // Reflect edits made elsewhere (edit modal, stage bar) without a refetch.
  // Merge so server-computed fields (note_count, aging) on the existing row
  // are preserved while edited columns (risk, stage, AE, ...) update.
  useAccountUpdates(useCallback((acct) => {
    setAccounts(list => list.map(a => (a.id === acct.id ? { ...a, ...acct } : a)));
  }, []));

  useEffect(() => {
    if (query) setParams({ q: query }); else setParams({});
  }, [query, setParams]);

  const aes = useMemo(() => {
    const s = new Set();
    accounts.forEach(a => a.account_executive && s.add(a.account_executive));
    return ['All', ...Array.from(s).sort()];
  }, [accounts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return accounts.filter(a => {
      if (aeFilter !== 'All' && (a.account_executive || '') !== aeFilter) return false;
      if (tagFilter !== 'All' && !(a.tags || []).includes(tagFilter)) return false;
      if (!q) return true;
      return (a.account_name || '').toLowerCase().includes(q) ||
             (a.account_executive || '').toLowerCase().includes(q) ||
             (a.tags || []).some(t => t.toLowerCase().includes(q));
    });
  }, [accounts, query, aeFilter, tagFilter]);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Accounts</h1>
          <div className="text-[12px] text-text-muted mt-1">{accounts.length} accounts total · {filtered.length} shown</div>
        </div>
      </div>

      <input
        type="text"
        placeholder="Search by account name or AE"
        value={query}
        onChange={e => setQuery(e.target.value)}
        className="w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50 mb-3"
      />

      <div className="flex flex-wrap gap-1.5 mb-4">
        {aes.map(ae => (
          <button
            key={ae}
            onClick={() => setAeFilter(ae)}
            className={`px-2.5 py-1 rounded text-[11px] border transition ${
              aeFilter === ae
                ? 'bg-accent-blue/15 text-accent-blue border-accent-blue/30'
                : 'bg-card text-text-muted border-border hover:text-text-primary'
            }`}
          >
            {ae}
          </button>
        ))}
      </div>

      {tagCatalog.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <span className="text-[10px] text-text-dim mr-1">Tags:</span>
          <button
            onClick={() => setTagFilter('All')}
            className={`px-2.5 py-1 rounded-full text-[11px] border transition ${
              tagFilter === 'All' ? 'bg-accent-blue/15 text-accent-blue border-accent-blue/30' : 'bg-card text-text-muted border-border hover:text-text-primary'
            }`}
          >
            All
          </button>
          {tagCatalog.map(t => {
            const active = tagFilter === t.label;
            return (
              <button
                key={t.id}
                onClick={() => setTagFilter(active ? 'All' : t.label)}
                className="px-2.5 py-1 rounded-full text-[11px] border font-medium transition"
                style={active
                  ? { color: t.color, background: `${t.color}22`, borderColor: `${t.color}88` }
                  : { color: t.color, background: 'transparent', borderColor: `${t.color}44` }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {filtered.length === 0 && (
          <div className="text-center py-12 text-text-dim text-[12px] border border-dashed border-border rounded-lg">
            No accounts match. <Link to="/new" className="text-accent-blue underline">Create one</Link>.
          </div>
        )}
        {filtered.map(a => (
          <Link
            key={a.id}
            to={`/accounts/${a.id}`}
            className={`flex items-center gap-3 px-4 py-3 bg-card border border-border rounded hover:border-accent-blue/40 hover:bg-[#111f42] transition ${isInactive(a) ? 'opacity-55 hover:opacity-100' : ''}`}
          >
            <div className="flex items-center shrink-0">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ background: agingColor(a.last_note_days_ago, a.note_count > 0) }}
                title={a.last_note_days_ago == null ? 'No notes yet' : `${a.last_note_days_ago}d since last note`}
              />
            </div>
            <div
              className="w-9 h-9 rounded flex items-center justify-center text-[11px] font-semibold shrink-0"
              style={{ background: `${colorForName(a.account_name)}22`, color: colorForName(a.account_name) }}
            >
              {initials(a.account_name)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[13px] font-medium text-text-primary truncate">{a.account_name}</span>
                {(a.tags || []).map(label => {
                  const color = tagColor[label] || '#838892';
                  return (
                    <span key={label} className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
                      style={{ color, background: `${color}22`, border: `1px solid ${color}55` }}>
                      {label}
                    </span>
                  );
                })}
              </div>
              <div className="text-[11px] text-text-muted truncate">
                {(a.ae_name || a.account_executive) ? `AE: ${a.ae_name || a.account_executive}` : 'No AE'}
                {' · '}
                {a.note_count} {a.note_count === 1 ? 'entry' : 'entries'}
                {' · '}
                {a.attachment_count} files
                {' · '}
                {a.transcript_count} transcripts
              </div>
            </div>
            {a.presales_stage
              ? <span className={`text-[11px] px-2 py-0.5 rounded shrink-0 font-medium ${stageBadgeClass(a.presales_stage)}`}>{a.presales_stage}</span>
              : <span className="text-[11px] text-text-dim shrink-0">No stage</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}
