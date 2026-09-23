import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import Card from '../components/Card.jsx';
import { useToast } from '../components/Toast.jsx';

// Product documentation used to ground POV generation.
//
// Two timestamps matter here and they are not the same thing: when this
// machine last pulled a corpus, and how fresh the corpus it pulled actually
// was. A sync that ran an hour ago against a month-old scrape is stale
// documentation either way, so both are shown rather than one "last updated".
export default function DocsSyncSettings() {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef(null);

  async function load() {
    try { setState(await api.getDocsSync()); }
    catch (e) { toast(`Could not load docs sync status: ${e.message}`, 'error'); }
  }
  useEffect(() => {
    load();
    return () => clearInterval(poll.current);
  }, []);

  // A refresh takes a minute or two and runs detached on the server, so the
  // only way to see it finish is to keep asking.
  useEffect(() => {
    clearInterval(poll.current);
    if (state?.running) poll.current = setInterval(load, 3000);
    return () => clearInterval(poll.current);
  }, [state?.running]);

  async function runNow() {
    setBusy(true);
    try {
      await api.runDocsSync();
      toast('Refreshing documentation — this takes a minute or two', 'success');
      await load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  const { local, source, running } = state;

  const when = (iso) => {
    if (!iso) return 'never';
    const d = new Date(iso);
    const mins = (Date.now() - d.getTime()) / 60000;
    if (mins < 1) return 'just now';
    if (mins < 60) return `${Math.round(mins)}m ago`;
    if (mins < 60 * 36) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
  };
  const exact = (iso) => (iso ? new Date(iso).toLocaleString() : '');

  return (
    <Card className="p-6 mt-4">
      <div className="text-[13px] font-medium text-text-primary mb-1">Product documentation</div>
      <p className="text-[12px] text-text-muted mb-4 leading-relaxed">
        POV generation is grounded in OPSWAT product docs held locally. They are refreshed from
        the docs-rag service, which scrapes the documentation site weekly and keeps only current
        product versions.
      </p>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-text-dim mb-1">Last refreshed here</div>
          <div className="text-[13px] text-text-primary" title={exact(local?.finished_at)}>
            {when(local?.finished_at)}
          </div>
          <div className="text-[11px] text-text-muted mt-0.5">
            {local?.ok === false
              ? <span className="text-accent-red">failed — {local.error}</span>
              : local?.chunks
                ? `${local.chunks.toLocaleString()} chunks · ${local.products} products`
                : 'no successful refresh yet'}
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wide text-text-dim mb-1">Documentation scraped</div>
          <div className="text-[13px] text-text-primary" title={exact(source?.corpus_last_fetch)}>
            {source?.reachable ? when(source.corpus_last_fetch) : '—'}
          </div>
          <div className="text-[11px] text-text-muted mt-0.5">
            {source?.reachable
              ? `${(source.documents ?? 0).toLocaleString()} documents available`
              : <span className="text-accent-red">docs-rag unreachable</span>}
          </div>
        </div>
      </div>

      {/* Unreachable is not an error state for POVs — the local collection is
          intact and generation keeps working. Say so, so it doesn't read as
          a broken pipeline. */}
      {!source?.reachable && (
        <div className="text-[12px] text-text-muted bg-[#040d1c] border border-border rounded px-3 py-2 mb-4">
          Cannot reach {source?.url} ({source?.error}). POV generation still works from the
          documentation already held here; it just will not pick up newer docs until the
          service is back.
        </div>
      )}
      {source?.reachable && !source?.ready && (
        <div className="text-[12px] text-accent-orange bg-[#040d1c] border border-border rounded px-3 py-2 mb-4">
          docs-rag is still preparing {source.missing_vectors?.toLocaleString()} chunk(s).
          A refresh will be refused until that finishes.
        </div>
      )}

      <button
        onClick={runNow}
        disabled={busy || running || !source?.reachable || !source?.ready}
        className="bg-accent-blue/15 hover:bg-accent-blue/25 disabled:opacity-40 disabled:hover:bg-accent-blue/15
                   text-accent-blue border border-accent-blue/30 rounded px-4 py-1.5 text-[12px] font-medium"
      >
        {running ? 'Refreshing…' : busy ? 'Starting…' : 'Refresh documentation now'}
      </button>
    </Card>
  );
}
