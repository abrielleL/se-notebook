import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { riskDot, PRESALES_STAGES, stageColor, accountType } from '../lib/constants.js';
import AccountTypeTabs from '../components/AccountTypeTabs.jsx';
import SnoozeMenu, { snoozeTitle } from '../components/SnoozeMenu.jsx';
import TablerIcon from '../components/TablerIcon.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate } from '../lib/stage.js';
import { emitAccountUpdated } from '../lib/accountStore.js';
import { currentQuarter, quarterRangeLabel, workedInQuarter } from '../lib/quarter.js';

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
  // Snoozed accounts are hidden from the board but never gone: this reveals
  // them in place, dimmed, so nothing disappears without a way back.
  const [showSnoozed, setShowSnoozed] = useState(false);
  // 'quarter' | 'all'. Opens on the quarter so the board is what you're
  // actually working, with everything one click away.
  const [scope, setScope] = useState('quarter');
  const quarter = useMemo(() => currentQuarter(), []);
  const toast = useToast();

  useEffect(() => {
    api.listAccounts().then(setAccounts).finally(() => setLoading(false));
  }, []);

  // Replace the row in place so the board doesn't jump on a snooze/unsnooze.
  const applyAccount = (updated) =>
    setAccounts(list => list.map(a => (a.id === updated.id ? { ...a, ...updated } : a)));

  async function snooze(account, { days, reason }) {
    try {
      const updated = await api.snoozeAccount(account.id, { days, reason });
      applyAccount(updated);
      emitAccountUpdated(updated);
      const when = updated.snoozed_until ? `until ${formatDate(updated.snoozed_until)}` : 'indefinitely';
      toast(`${account.account_name} snoozed ${when}`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function unsnooze(account) {
    try {
      const updated = await api.unsnoozeAccount(account.id);
      applyAccount(updated);
      emitAccountUpdated(updated);
      toast(`${account.account_name} is back on the board`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  const counts = useMemo(() => {
    const c = { customer: 0, partner: 0 };
    accounts.forEach(a => { c[accountType(a)]++; });
    return c;
  }, [accounts]);

  const isPartnerTab = typeTab === 'partner';
  const ofType = useMemo(() => accounts.filter(a => accountType(a) === typeTab), [accounts, typeTab]);
  // Filters compose: account type -> snooze -> quarter scope. Snoozed and
  // out-of-quarter are separate ideas, so revealing snoozed accounts doesn't
  // drag in stale ones and vice versa.
  const inScope = useMemo(
    () => (scope === 'quarter' ? ofType.filter(a => workedInQuarter(a, quarter)) : ofType),
    [ofType, scope, quarter]
  );
  const snoozedCount = useMemo(() => inScope.filter(a => a.is_snoozed).length, [inScope]);
  const visible = useMemo(
    () => (showSnoozed ? inScope : inScope.filter(a => !a.is_snoozed)),
    [inScope, showSnoozed]
  );
  // Toggle labels need both totals, ignoring the snooze reveal.
  const scopeCounts = useMemo(() => {
    const live = ofType.filter(a => !a.is_snoozed);
    return { quarter: live.filter(a => workedInQuarter(a, quarter)).length, all: live.length };
  }, [ofType, quarter]);

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
            {isPartnerTab ? 'Partners' : 'Accounts by stage'}
          </h1>
          <div className="text-[12px] text-text-muted mt-1 flex items-center gap-2">
            <span>
              {visible.length} {typeTab === 'partner' ? 'partner' : 'account'}{visible.length === 1 ? '' : 's'}
              {scope === 'quarter' && <span className="text-text-dim"> · {quarterRangeLabel(quarter)}</span>}
            </span>
            {snoozedCount > 0 && (
              <button
                onClick={() => setShowSnoozed(s => !s)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] transition ${
                  showSnoozed
                    ? 'bg-accent-blue/15 text-accent-blue border-accent-blue/30'
                    : 'bg-card text-text-dim border-border hover:text-text-primary'
                }`}
                title={showSnoozed ? 'Hide snoozed accounts again' : 'Show snoozed accounts in place'}
              >
                <TablerIcon name="ti-zzz" />
                {snoozedCount} snoozed
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Scope: what you're working this quarter vs the whole book.
              "Working" means a note dated inside the quarter — see quarter.js
              for why activity rather than close date. */}
          <div className="inline-flex items-center gap-1 p-1 bg-card border border-border rounded-lg">
            {[
              { value: 'quarter', label: quarter.label, n: scopeCounts.quarter,
                title: `Accounts with a note dated in ${quarter.label} (${quarterRangeLabel(quarter)})` },
              { value: 'all', label: 'All', n: scopeCounts.all,
                title: 'Every account, however long since the last note' }
            ].map(o => {
              const active = scope === o.value;
              return (
                <button
                  key={o.value}
                  onClick={() => setScope(o.value)}
                  title={o.title}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition ${
                    active
                      ? 'bg-accent-blue/15 text-accent-blue shadow-[inset_0_0_0_1px_rgba(92,155,255,0.35)]'
                      : 'text-text-dim hover:text-text-primary'
                  }`}
                >
                  {o.label}
                  <span className={`text-[11px] tabular-nums ${active ? 'opacity-70' : 'text-text-dim'}`}>{o.n}</span>
                </button>
              );
            })}
          </div>
          <AccountTypeTabs value={typeTab} onChange={setTypeTab} counts={counts} />
        </div>
      </div>

      {/* Per-stage counts — the stage board is customer-only */}
      {!isPartnerTab && (
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
      )}

      {/* Accounts as a stage board (one column per stage) */}
      {visible.length === 0 ? (
        <div className="text-center py-12 text-text-dim text-[12px] border border-dashed border-border rounded-lg">
          {/* Distinguish "nothing here" from "the quarter filter hid it all" --
              otherwise an empty board reads as lost data. */}
          {scope === 'quarter' && scopeCounts.all > 0 ? (
            <>
              No {typeTab === 'partner' ? 'partners' : 'accounts'} worked in {quarter.label}.{' '}
              <button onClick={() => setScope('all')} className="text-accent-blue underline">
                Show all {scopeCounts.all}
              </button>.
            </>
          ) : (
            <>
              No {typeTab === 'partner' ? 'partners' : 'accounts'} yet. <Link to="/new" className="text-accent-blue underline">Create one</Link>.
            </>
          )}
        </div>
      ) : isPartnerTab ? (
        // Partners have no stage to group by, so they get a flat grid showing
        // the accounts each one is working — the thing you actually want to
        // know when you open a partner.
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {visible.map(p => {
            const linked = p.linked_accounts || [];
            return (
              <Link key={p.id} to={`/accounts/${p.id}`}
                title={snoozeTitle(p)}
                className={`group flex flex-col gap-2 bg-card border border-border rounded-lg px-3 py-2.5 hover:border-accent-blue/40 hover:bg-[#111f42] transition ${p.is_snoozed ? 'opacity-50 hover:opacity-100' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: riskDot(p.risk) }} title={`Risk: ${p.risk || 'none'}`} />
                  <span className="text-[12px] font-medium text-text-primary truncate flex-1 min-w-0">{p.account_name}</span>
                  <SnoozeMenu account={p} compact revealOnHover
                    onSnooze={(opts) => snooze(p, opts)}
                    onUnsnooze={() => unsnooze(p)} />
                  <span className="text-[10px] text-text-dim shrink-0">{p.note_count} {p.note_count === 1 ? 'entry' : 'entries'}</span>
                </div>
                {p.is_snoozed && (
                  <div className="text-[10px] text-accent-blue/80 truncate">
                    Snoozed {p.snoozed_until ? `until ${formatDate(p.snoozed_until)}` : 'indefinitely'}
                    {p.snooze_reason ? ` — ${p.snooze_reason}` : ''}
                  </div>
                )}
                <div className="text-[10px] text-text-dim">
                  {linked.length ? `${linked.length} linked account${linked.length === 1 ? '' : 's'}` : 'No linked accounts'}
                </div>
                {linked.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {linked.map(l => (
                      <span key={l.id} className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#111f42] text-text-muted border border-border truncate max-w-[120px]">
                        {l.account_name}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
            );
          })}
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
                    title={snoozeTitle(a)}
                    className={`group block bg-card border border-border rounded px-3 py-2 hover:border-accent-blue/40 hover:bg-[#111f42] transition ${a.is_snoozed ? 'opacity-50 hover:opacity-100' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: riskDot(a.risk) }} title={`Risk: ${a.risk || 'none'}`} />
                      <span className="text-[12px] font-medium text-text-primary truncate flex-1 min-w-0">{a.account_name}</span>
                      {/* revealOnHover lives inside SnoozeMenu so an open menu
                          stays visible once the pointer leaves the card. */}
                      <SnoozeMenu account={a} compact revealOnHover
                        onSnooze={(opts) => snooze(a, opts)}
                        onUnsnooze={() => unsnooze(a)} />
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-text-dim">
                      <span className="truncate flex-1 min-w-0">{a.ae_name || a.account_executive || 'No AE'}</span>
                      {fmtMoney(a.opportunity_value) && <span className="shrink-0 text-text-muted">{fmtMoney(a.opportunity_value)}</span>}
                    </div>
                    {a.is_snoozed && (
                      <div className="text-[10px] text-accent-blue/80 mt-1 truncate">
                        Snoozed {a.snoozed_until ? `until ${formatDate(a.snoozed_until)}` : 'indefinitely'}
                        {a.snooze_reason ? ` — ${a.snooze_reason}` : ''}
                      </div>
                    )}
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
