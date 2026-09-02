import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { riskDot, PRESALES_STAGES, stageColor, accountType } from '../lib/constants.js';
import AccountTypeTabs from '../components/AccountTypeTabs.jsx';

const NO_STAGE = 'No stage';
const STAGE_ORDER = [...PRESALES_STAGES, NO_STAGE];
const slug = (s) => 'stage-' + s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const dotFor = (s) => (s === NO_STAGE ? '#616875' : stageColor(s).dot);

function fmtMoney(n) {
  if (!n) return null;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

export default function Dashboard() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  // The board defaults to customers — partners don't move through the presales
  // stages the same way, so they'd distort the per-stage counts.
  const [typeTab, setTypeTab] = useState('customer');

  useEffect(() => {
    api.listAccounts().then(setAccounts).finally(() => setLoading(false));
  }, []);

  const counts = useMemo(() => {
    const c = { customer: 0, partner: 0 };
    accounts.forEach(a => { c[accountType(a)]++; });
    return c;
  }, [accounts]);

  const visible = useMemo(() => accounts.filter(a => accountType(a) === typeTab), [accounts, typeTab]);

  // Group accounts by presales stage (accounts with no/unknown stage bucket last).
  const groups = useMemo(() => {
    const m = {};
    for (const s of STAGE_ORDER) m[s] = [];
    for (const a of visible) {
      const key = a.presales_stage && PRESALES_STAGES.includes(a.presales_stage) ? a.presales_stage : NO_STAGE;
      m[key].push(a);
    }
    for (const s of STAGE_ORDER) m[s].sort((x, y) => (x.account_name || '').localeCompare(y.account_name || ''));
    return m;
  }, [visible]);

  if (loading) return <div className="p-8 text-[12px] text-text-muted">Loading dashboard…</div>;

  return (
    <div className="p-6 max-w-[1500px] mx-auto flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">
            {typeTab === 'partner' ? 'Partners by stage' : 'Accounts by stage'}
          </h1>
          <div className="text-[12px] text-text-muted mt-1">
            {visible.length} {typeTab === 'partner' ? 'partner' : 'account'}{visible.length === 1 ? '' : 's'}
          </div>
        </div>
        <AccountTypeTabs value={typeTab} onChange={setTypeTab} counts={counts} />
      </div>

      {/* Per-stage counts */}
      <div className="flex flex-wrap gap-2">
        {STAGE_ORDER.map(s => {
          const count = groups[s].length;
          return (
            <button
              key={s}
              onClick={() => document.getElementById(slug(s))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              disabled={!count}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border bg-card transition ${count ? 'border-border hover:border-accent-blue/40' : 'border-border opacity-40 cursor-default'}`}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dotFor(s) }} />
              <span className="text-[18px] font-semibold text-text-primary tabular-nums">{count}</span>
              <span className="text-[11px] text-text-muted whitespace-nowrap">{s}</span>
            </button>
          );
        })}
      </div>

      {/* Accounts as a stage board (one column per stage) */}
      {visible.length === 0 ? (
        <div className="text-center py-12 text-text-dim text-[12px] border border-dashed border-border rounded-lg">
          No {typeTab === 'partner' ? 'partners' : 'accounts'} yet. <Link to="/new" className="text-accent-blue underline">Create one</Link>.
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {STAGE_ORDER.map(s => (
            <div key={s} id={slug(s)} className="flex flex-col scroll-mt-4">
              <div className="flex items-center gap-2 mb-2 px-0.5">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: dotFor(s) }} />
                <h2 className="text-[12px] font-semibold text-text-primary truncate flex-1">{s}</h2>
                <span className="text-[11px] text-text-dim shrink-0">{groups[s].length}</span>
              </div>
              <div className="flex flex-col gap-1.5 overflow-y-auto pr-0.5" style={{ maxHeight: '60vh' }}>
                {groups[s].length === 0 && (
                  <div className="text-[10px] text-text-dim italic border border-dashed border-border rounded px-3 py-3 text-center">No accounts</div>
                )}
                {groups[s].map(a => (
                  <Link key={a.id} to={`/accounts/${a.id}`}
                    className="block bg-card border border-border rounded px-3 py-2 hover:border-accent-blue/40 hover:bg-[#111f42] transition">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: riskDot(a.risk) }} title={`Risk: ${a.risk || 'none'}`} />
                      <span className="text-[12px] font-medium text-text-primary truncate flex-1 min-w-0">{a.account_name}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-text-dim">
                      <span className="truncate flex-1 min-w-0">{a.ae_name || a.account_executive || 'No AE'}</span>
                      {fmtMoney(a.opportunity_value) && <span className="shrink-0 text-text-muted">{fmtMoney(a.opportunity_value)}</span>}
                    </div>
                    {(a.tags || []).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {a.tags.slice(0, 3).map(t => (
                          <span key={t} className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#111f42] text-text-muted border border-border">{t}</span>
                        ))}
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
