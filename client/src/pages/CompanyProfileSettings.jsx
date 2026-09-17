import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import Card from '../components/Card.jsx';
import Icon from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';

// Bulk company-profile backfill.
//
// This runs in the browser rather than as a server job on purpose: the
// Anthropic key lives in localStorage and is forwarded per request, so the
// server has no key of its own to run a batch with. Accounts are done one at a
// time -- it keeps the request rate civil toward the sites being read, and it
// makes a failure legible (you can see which account it was) instead of
// arriving as one collapsed error.
export default function CompanyProfileSettings() {
  const toast = useToast();
  const [accounts, setAccounts] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState([]);
  const stopRef = useRef(false);

  const reload = () => api.listAccounts().then(setAccounts).catch(() => {});
  useEffect(() => { reload(); }, []);

  const groups = useMemo(() => {
    const hasUrl = (a) => !!(a.website_url || '').trim();
    const hasProfile = (a) => !!(a.company_profile || '').trim();
    return {
      pending: accounts.filter(a => hasUrl(a) && !hasProfile(a)),
      done: accounts.filter(a => hasProfile(a)),
      noUrl: accounts.filter(a => !hasUrl(a))
    };
  }, [accounts]);

  async function run(targets) {
    if (!targets.length) return;
    stopRef.current = false;
    setRunning(true);
    setResults([]);
    setProgress({ done: 0, total: targets.length });

    const out = [];
    for (let i = 0; i < targets.length; i++) {
      if (stopRef.current) break;
      const a = targets[i];
      try {
        const r = await api.fetchCompanyProfile(a.id);
        out.push({
          id: a.id,
          name: a.account_name,
          status: 'ok',
          detail: r.company_profile,
          industry: r.industry,
          suggested: r.industry_suggested
        });
      } catch (e) {
        out.push({ id: a.id, name: a.account_name, status: 'error', detail: e.message });
      }
      setResults([...out]);
      setProgress({ done: i + 1, total: targets.length });
    }

    setRunning(false);
    await reload();
    const failed = out.filter(r => r.status === 'error').length;
    toast(failed
      ? `${out.length - failed} profile${out.length - failed === 1 ? '' : 's'} written, ${failed} need a look`
      : `${out.length} profile${out.length === 1 ? '' : 's'} written`,
      failed ? 'warn' : 'success');
  }

  const failedResults = results.filter(r => r.status === 'error');
  const retryTargets = accounts.filter(a => failedResults.some(f => f.id === a.id));

  return (
    <Card className="p-6 mt-6">
      <div className="text-[13px] font-medium text-text-primary mb-1">Company Profiles</div>
      <p className="text-[12px] text-text-muted mb-4 leading-relaxed">
        Reads each account's website and writes a short description of what the business does, filling in the
        industry where it's blank. Runs one account at a time and costs roughly a cent each. Company information
        only — it never touches the AI summary built from your notes.
      </p>

      <div className="flex items-center gap-4 mb-4 text-[11px]">
        <span className="text-text-secondary"><span className="text-accent-green font-medium">{groups.done.length}</span> with a profile</span>
        <span className="text-text-secondary"><span className="text-accent-blue font-medium">{groups.pending.length}</span> ready to read</span>
        <span className="text-text-secondary"><span className="text-text-dim font-medium">{groups.noUrl.length}</span> with no website</span>
      </div>

      {running ? (
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 h-1.5 bg-[#040d1c] rounded overflow-hidden">
            <div className="h-full bg-accent-blue transition-all"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
          <span className="text-[11px] text-text-muted shrink-0">{progress.done} / {progress.total}</span>
          <button onClick={() => { stopRef.current = true; }} className="text-[11px] text-accent-red hover:underline shrink-0">Stop</button>
        </div>
      ) : (
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => run(groups.pending)} disabled={!groups.pending.length}
            className="flex items-center gap-1.5 text-[11px] text-accent-blue hover:underline disabled:opacity-40 disabled:hover:no-underline">
            <Icon.Sparkles width={12} height={12} />
            {groups.pending.length ? `Read ${groups.pending.length} website${groups.pending.length === 1 ? '' : 's'}` : 'Nothing to read'}
          </button>
          {retryTargets.length > 0 &&
            <button onClick={() => run(retryTargets)} className="flex items-center gap-1.5 text-[11px] text-text-secondary hover:text-accent-blue">
              <Icon.Refresh width={12} height={12} /> Retry {retryTargets.length} failed
            </button>}
          {groups.done.length > 0 &&
            <button onClick={() => run(groups.done)} className="text-[11px] text-text-dim hover:text-text-secondary ml-auto"
              title="Re-reads every website and overwrites the existing profiles">
              Re-read all {groups.done.length}
            </button>}
        </div>
      )}

      {results.length > 0 &&
        <div className="flex flex-col gap-1 max-h-[280px] overflow-auto border border-border rounded p-2">
          {results.map(r => (
            <div key={r.id} className="flex items-start gap-2 text-[11px] px-1 py-1">
              <span className={`shrink-0 mt-0.5 ${r.status === 'ok' ? 'text-accent-green' : 'text-accent-red'}`}>
                {r.status === 'ok' ? '✓' : '✕'}
              </span>
              <span className="text-text-primary shrink-0 w-[150px] truncate" title={r.name}>{r.name}</span>
              <span className={r.status === 'ok' ? 'text-text-muted' : 'text-accent-red/90'}>
                {r.status === 'ok'
                  ? <>{r.industry && <span className="text-text-secondary">{r.industry} — </span>}{r.detail}
                      {r.suggested && <span className="text-accent-yellow"> (suggested industry: {r.suggested})</span>}</>
                  : r.detail}
              </span>
            </div>
          ))}
        </div>}

      {groups.noUrl.length > 0 && !running &&
        <p className="text-[11px] text-text-dim mt-3 leading-relaxed">
          No website on file: {groups.noUrl.map(a => a.account_name).join(', ')}. Add one on the account page
          and it will show up here.
        </p>}
    </Card>
  );
}
