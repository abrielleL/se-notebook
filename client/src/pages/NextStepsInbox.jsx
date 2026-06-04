import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import Card, { CardHeader } from '../components/Card.jsx';
import Icon from '../components/Icons.jsx';
import { riskDot, dueColor } from '../lib/constants.js';
import { formatDate } from '../lib/stage.js';

export default function NextStepsInbox() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // filter state
  const [filterAccount, setFilterAccount] = useState('all');
  const [showCompleted, setShowCompleted] = useState(false);

  // per-group "clear completed" hidden sets: { [account_id]: true }
  const [clearedGroups, setClearedGroups] = useState({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const accts = await api.listAccounts();
        const details = await Promise.all(accts.map((a) => api.getAccount(a.id)));
        if (!cancelled) {
          setAccounts(details);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || 'Failed to load accounts');
          setLoading(false);
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // toggle a next step's completed state locally + API
  async function toggleStep(accountId, stepId, currentCompleted) {
    const newVal = !currentCompleted;
    // optimistic local update
    setAccounts((prev) =>
      prev.map((a) => {
        if (a.id !== accountId) return a;
        return {
          ...a,
          next_steps: (a.next_steps || []).map((s) =>
            s.id === stepId ? { ...s, completed: newVal } : s
          ),
        };
      })
    );
    try {
      await api.updateNextStep(stepId, { completed: newVal });
    } catch {
      // revert on failure
      setAccounts((prev) =>
        prev.map((a) => {
          if (a.id !== accountId) return a;
          return {
            ...a,
            next_steps: (a.next_steps || []).map((s) =>
              s.id === stepId ? { ...s, completed: currentCompleted } : s
            ),
          };
        })
      );
    }
  }

  function clearCompleted(accountId) {
    setClearedGroups((prev) => ({ ...prev, [accountId]: true }));
  }

  // Build grouped data
  const groups = useMemo(() => {
    return accounts
      .filter((a) => filterAccount === 'all' || String(a.id) === String(filterAccount))
      .map((a) => {
        const steps = a.next_steps || [];
        const visibleSteps = steps.filter((s) => {
          if (s.completed) {
            // if group is cleared, hide completed regardless of showCompleted
            if (clearedGroups[a.id]) return false;
            return showCompleted;
          }
          return true;
        });
        const hasCompleted = steps.some((s) => s.completed);
        const openCount = steps.filter((s) => !s.completed).length;
        return { account: a, steps: visibleSteps, hasCompleted, openCount };
      })
      .filter((g) => g.steps.length > 0);
  }, [accounts, filterAccount, showCompleted, clearedGroups]);

  const totalOpen = useMemo(
    () => accounts.reduce((sum, a) => sum + (a.next_steps || []).filter((s) => !s.completed).length, 0),
    [accounts]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <span className="text-[12px] text-text-muted font-mono">Loading…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <div className="px-4 py-3 text-[12px] text-accent-red font-mono">{error}</div>
        </Card>
      </div>
    );
  }

  const allOpen = accounts.flatMap((a) => (a.next_steps || []).filter((s) => !s.completed));
  const isEmpty = allOpen.length === 0;

  return (
    <div className="p-6 space-y-4 font-mono">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <h1 className="text-[13px] font-semibold text-text-primary">Next Steps Inbox</h1>
        {totalOpen > 0 && (
          <span className="border border-border rounded px-1.5 py-0.5 text-[10px] text-accent-blue bg-[#1a2744]">
            {totalOpen} open
          </span>
        )}
      </div>

      {/* Filter row */}
      <Card>
        <div className="flex items-center gap-4 px-3 py-2">
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-text-muted">Account</label>
            <select
              value={filterAccount}
              onChange={(e) => setFilterAccount(e.target.value)}
              className="bg-[#10141b] border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue"
            >
              <option value="all">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.account_name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              className="w-3 h-3 accent-accent-blue"
            />
            <span className="text-[11px] text-text-muted">Show completed</span>
          </label>
        </div>
      </Card>

      {/* Empty state */}
      {isEmpty && (
        <Card>
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Icon.Check width={24} height={24} className="text-accent-green" />
            <span className="text-[12px] text-text-muted">All caught up.</span>
          </div>
        </Card>
      )}

      {/* No visible groups (filters applied, but steps exist) */}
      {!isEmpty && groups.length === 0 && (
        <Card>
          <div className="px-4 py-6 text-[12px] text-text-muted text-center">
            No open steps match the current filter.
          </div>
        </Card>
      )}

      {/* Groups */}
      {groups.map(({ account, steps, hasCompleted }) => {
        const dot = riskDot(account.risk);
        const completedInView = steps.filter((s) => s.completed);
        const showClearBtn =
          hasCompleted && !clearedGroups[account.id] && (showCompleted ? completedInView.length > 0 : false);

        return (
          <Card key={account.id}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  {/* risk dot */}
                  <span
                    className="inline-block w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: dot }}
                  />
                  <span className="text-text-primary">{account.account_name}</span>
                  {account.presales_stage && (
                    <span className="border border-accent-blue rounded-full px-1.5 py-0.5 text-[10px] bg-[#1a2744] text-accent-blue whitespace-nowrap">
                      {account.presales_stage}
                    </span>
                  )}
                </span>
              }
              right={
                showClearBtn ? (
                  <button
                    onClick={() => clearCompleted(account.id)}
                    className="text-[10px] text-text-muted hover:text-accent-red border border-border rounded px-2 py-0.5 transition-colors"
                  >
                    Clear completed
                  </button>
                ) : null
              }
            />

            {/* Steps list */}
            <div className="p-2 space-y-1.5">
              {steps.map((step) => {
                const isCompleted = step.completed;
                const color = dueColor(step.due_date);
                return (
                  <div
                    key={step.id}
                    className="flex items-center gap-2 border border-border rounded px-3 py-2"
                    style={{ gap: '6px' }}
                  >
                    {/* Circular checkbox */}
                    <button
                      onClick={() => toggleStep(account.id, step.id, isCompleted)}
                      className={`shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
                        isCompleted
                          ? 'border-accent-green bg-accent-green'
                          : 'border-border bg-transparent hover:border-accent-green'
                      }`}
                      aria-label={isCompleted ? 'Mark incomplete' : 'Mark complete'}
                    >
                      {isCompleted && (
                        <Icon.Check
                          width={9}
                          height={9}
                          className="text-[#0d1117]"
                          strokeWidth={3}
                        />
                      )}
                    </button>

                    {/* Step text */}
                    <span
                      className={`flex-1 text-[12px] ${
                        isCompleted ? 'line-through text-text-dim' : 'text-text-primary'
                      }`}
                    >
                      {step.text}
                    </span>

                    {/* Sparkle (AI-extracted) */}
                    {step.source === 'ai' && (
                      <Icon.Sparkles
                        width={12}
                        height={12}
                        className="shrink-0"
                        style={{ color: '#bc8cff' }}
                      />
                    )}

                    {/* Due date badge */}
                    {step.due_date && (
                      <span
                        className="shrink-0 border rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap"
                        style={{ borderColor: color, color }}
                      >
                        {formatDate(step.due_date)}
                      </span>
                    )}

                    {/* Account link */}
                    <Link
                      to={`/accounts/${step.account_id}`}
                      className="shrink-0 text-[10px] text-text-muted hover:text-accent-blue transition-colors"
                    >
                      → account
                    </Link>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
