import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import Icon from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate } from '../lib/stage.js';
import Markdown, { stripMarkdown } from '../components/Markdown.jsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sectionText(pov) {
  try {
    const st = pov?.section_texts;
    if (!st || typeof st !== 'object') return '';
    return Object.values(st).filter(Boolean).join(' ');
  } catch { return ''; }
}

// Purpose snippet from the POV's first/Purpose section, lightly de-marked.
function purposeSnippet(pov) {
  const st = pov?.section_texts;
  if (!st || typeof st !== 'object') return '';
  const key = Object.keys(st).find(k => /purpose|section\s*1/i.test(k)) || Object.keys(st)[0];
  const raw = key ? String(st[key] || '') : '';
  const clean = raw.replace(/[#*_>`|-]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 160);
}

function deriveDuration(pov) {
  if (!pov?.start_date || !pov?.end_date) return null;
  const s = new Date(pov.start_date), e = new Date(pov.end_date);
  if (isNaN(s) || isNaN(e)) return null;
  const d = Math.round((e - s) / 86400000);
  return d >= 0 ? d : null;
}

// POV status badge styling.
const STATUS_STYLE = {
  draft: 'text-text-muted border-border',
  sent: 'text-accent-blue border-accent-blue/30 bg-accent-blue/10',
  'kicked off': 'text-accent-purple border-accent-purple/30 bg-accent-purple/10',
  'in progress': 'text-accent-yellow border-accent-yellow/30 bg-accent-yellow/10',
  closed: 'text-accent-green border-accent-green/30 bg-accent-green/10',
};
const statusClass = (s) => STATUS_STYLE[(s || '').toLowerCase()] || 'text-text-muted border-border';

// win_loss is stored lowercase ('win'/'loss') by the generator — compare case-insensitively.
const isWin = (wl) => (wl || '').toLowerCase() === 'win';
const isLoss = (wl) => (wl || '').toLowerCase() === 'loss';

const EXPORT_FILENAME_SECTIONS = ['active_pov']; // POV document only

// ─── Preview drawer ───────────────────────────────────────────────────────────

function PreviewDrawer({ pov, version, onClose, navigate, onDelete }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const sections = pov.section_texts && typeof pov.section_texts === 'object'
    ? Object.entries(pov.section_texts) : [];

  async function exportPdf() {
    setBusy(true);
    try {
      const { html } = await api.exportPdf(pov.account_id, EXPORT_FILENAME_SECTIONS, pov.id);
      const w = window.open('', '_blank');
      if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 400); }
      else toast('Popup blocked — allow popups to print.', 'warn');
    } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }

  async function exportDocx() {
    setBusy(true);
    try {
      const { blob, filename } = await api.exportDocx(pov.account_id, EXPORT_FILENAME_SECTIONS, pov.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[150] flex justify-end bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-[680px] h-full bg-card border-l border-border flex flex-col shadow-2xl">
        {/* header */}
        <div className="px-5 py-3 border-b border-border flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#10141b] text-text-muted border border-border font-medium shrink-0">v{version}</span>
              <span className="text-[14px] font-semibold text-text-primary truncate">{pov._account?.account_name || 'POV'}</span>
            </div>
            <div className="text-[11px] text-text-muted truncate">
              {pov.label ? `${pov.label} · ` : ''}{formatDate(pov.generated_at) || 'POV document'}
            </div>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary shrink-0"><Icon.X width={14} height={14} /></button>
        </div>

        {/* action bar */}
        <div className="px-5 py-2.5 border-b border-border flex items-center gap-2 shrink-0 flex-wrap">
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${statusClass(pov.status)}`}>{pov.status || 'Draft'}</span>
          {pov.win_loss && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${isWin(pov.win_loss) ? 'text-accent-green border-accent-green/30 bg-accent-green/10' : 'text-accent-red border-accent-red/30 bg-accent-red/10'}`}>{isWin(pov.win_loss) ? 'Win' : 'Loss'}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => { if (window.confirm(`Delete POV v${version} for ${pov._account?.account_name || 'this account'}? This can't be undone.`)) onDelete(pov); }}
              className="flex items-center gap-1.5 bg-card border border-border rounded px-3 py-1.5 text-[11px] text-text-muted hover:text-accent-red hover:border-accent-red/40">
              <Icon.Trash width={12} height={12} /> Delete
            </button>
            <button onClick={exportPdf} disabled={busy}
              className="flex items-center gap-1.5 bg-card border border-border rounded px-3 py-1.5 text-[11px] text-text-primary hover:border-accent-blue/40 disabled:opacity-40">
              <Icon.Export width={12} height={12} /> PDF
            </button>
            <button onClick={exportDocx} disabled={busy}
              className="flex items-center gap-1.5 bg-card border border-border rounded px-3 py-1.5 text-[11px] text-text-primary hover:border-accent-blue/40 disabled:opacity-40">
              <Icon.Download width={12} height={12} /> .docx
            </button>
            <button onClick={() => navigate(`/accounts/${pov.account_id}/pov-generator/${pov.id}`)}
              className="flex items-center gap-1.5 bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[11px] font-medium hover:bg-accent-blue/25">
              <Icon.Edit width={12} height={12} /> Open in generator
            </button>
          </div>
        </div>

        {/* document body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {sections.length === 0 ? (
            <div className="text-[12px] text-text-dim italic py-8 text-center">
              {pov.pov_text ? pov.pov_text : 'No generated content for this POV.'}
            </div>
          ) : (
            <div className="flex flex-col gap-5 max-w-[600px]">
              {sections.map(([heading, text]) => (
                <div key={heading}>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-accent-blue mb-1.5">{heading}</div>
                  {String(text || '').trim()
                    ? <Markdown className="text-[12px] text-text-secondary">{text}</Markdown>
                    : <span className="text-[12px] text-text-dim italic">empty</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────

function PovCard({ pov, version, products, deployment, useCases, onClick, onDelete }) {
  const duration = deriveDuration(pov);
  const snippet = purposeSnippet(pov);
  const meta = [deployment, duration != null ? `${duration}d` : null].filter(Boolean).join(' · ');

  function confirmDelete(e) {
    e.stopPropagation();
    if (window.confirm(`Delete POV v${version} for ${pov._account?.account_name || 'this account'}? This can't be undone.`)) onDelete(pov);
  }

  return (
    <div onClick={onClick} role="button" tabIndex={0}
      className="cursor-pointer text-left bg-card border border-border rounded-lg p-4 flex flex-col gap-2 hover:border-accent-blue/40 hover:bg-[#11161e] transition">
      <div className="flex items-start gap-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#10141b] text-text-muted border border-border font-medium shrink-0">v{version}</span>
        <span className="text-[13px] font-medium text-text-primary truncate flex-1">{pov._account?.account_name || '—'}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${statusClass(pov.status)}`}>{pov.status || 'Draft'}</span>
        {pov.win_loss && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${isWin(pov.win_loss) ? 'text-accent-green border-accent-green/30 bg-accent-green/10' : 'text-accent-red border-accent-red/30 bg-accent-red/10'}`}>{isWin(pov.win_loss) ? 'Win' : 'Loss'}</span>
        )}
        <button onClick={confirmDelete} title="Delete POV" className="text-text-dim hover:text-accent-red shrink-0"><Icon.Trash width={12} height={12} /></button>
      </div>

      {pov.label && <div className="text-[11px] text-text-muted truncate -mt-1">{pov.label}</div>}

      {/* Products */}
      {products.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {products.slice(0, 3).map(p => (
            <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-[#1a2744] text-accent-blue border border-[#1e3a6e] font-medium">{p}</span>
          ))}
          {products.length > 3 && <span className="text-[10px] text-text-dim self-center">+{products.length - 3}</span>}
        </div>
      ) : (
        <div className="text-[10px] text-text-dim italic">No products tagged</div>
      )}

      {meta && <div className="text-[11px] text-text-muted truncate">{meta}</div>}

      {useCases.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {useCases.slice(0, 3).map(u => (
            <span key={u} className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#10141b] text-text-muted border border-border">{u}</span>
          ))}
          {useCases.length > 3 && <span className="text-[9px] text-text-dim">+{useCases.length - 3}</span>}
        </div>
      )}

      {snippet && <div className="text-[11px] text-text-dim leading-snug line-clamp-2">{stripMarkdown(snippet)}…</div>}

      <div className="flex items-center justify-between mt-1 pt-2 border-t border-border">
        <span className="text-[10px] text-text-dim">
          {pov.start_date || pov.end_date ? `${formatDate(pov.start_date) || '?'} – ${formatDate(pov.end_date) || '?'}` : 'No dates'}
        </span>
        <span className="text-[10px] text-accent-blue font-medium">Preview →</span>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function PovLibrary() {
  const navigate = useNavigate();
  const toast = useToast();

  const [povs, setPovs] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [outcomeFilter, setOutcomeFilter] = useState('All'); // All | Win | Loss | Open
  const [industryFilter, setIndustryFilter] = useState('All');
  const [productFilter, setProductFilter] = useState('All');
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getPovConfig().then(c => { if (!cancelled) setCfg(c); }).catch(() => {});
    api.listAccounts()
      .then(accts => Promise.all(
        (Array.isArray(accts) ? accts : []).map(a =>
          api.listPov(a.id).then(list => (Array.isArray(list) ? list : []).map(p => ({ ...p, _account: a }))).catch(() => [])
        )
      ))
      .then(nested => { if (!cancelled) { setPovs(nested.flat()); setLoading(false); } })
      .catch(err => { if (!cancelled) { setError(err?.message || 'Failed to load POVs'); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  // Slug → label via the managed POV config.
  const labelOf = useMemo(() => {
    const maps = {};
    if (cfg) for (const cat of Object.keys(cfg)) {
      maps[cat] = Object.fromEntries((cfg[cat] || []).map(o => [o.value, o.label]));
    }
    return (cat, slug) => maps[cat]?.[slug] || slug;
  }, [cfg]);

  // Catalog product labels, for the document-text fallback below.
  const productLabels = useMemo(() => (cfg?.product || []).map(o => o.label), [cfg]);

  // Products tied to a POV: prefer the stored preflight selections; if none were
  // captured (older POVs store products: []), fall back to detecting catalog
  // product names in the generated document text.
  const povProducts = (pov) => {
    const sel = pov.selections?.products || [];
    if (sel.length) return sel.map(s => labelOf('product', s));
    const text = sectionText(pov).toLowerCase();
    if (!text || !productLabels.length) return [];
    return productLabels.filter(l => text.includes(l.toLowerCase()));
  };
  const povDeployment = (pov) => {
    const d = pov.selections?.deployment?.[0];
    return d ? labelOf('deployment', d) : null;
  };
  const povUseCases = (pov) => (pov.selections?.use_cases || []).map(s => labelOf('use_case', s));

  // Version numbers per account, by creation order (oldest = v1).
  const versionOf = useMemo(() => {
    const byAcct = {};
    povs.forEach(p => (byAcct[p.account_id] ||= []).push(p));
    const m = {};
    Object.values(byAcct).forEach(list =>
      [...list].sort((a, b) => a.id - b.id).forEach((p, i) => { m[p.id] = i + 1; })
    );
    return m;
  }, [povs]);

  async function deletePov(pov) {
    try {
      await api.deletePovDraft(pov.id);
      setPovs(list => list.filter(p => p.id !== pov.id));
      setPreview(cur => (cur && cur.id === pov.id ? null : cur));
      toast('POV deleted', 'success');
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
  }

  const industries = useMemo(() => {
    const set = new Set();
    povs.forEach(p => p._account?.industry && set.add(p._account.industry));
    return ['All', ...Array.from(set).sort()];
  }, [povs]);

  const productOptions = useMemo(() => {
    const set = new Set();
    povs.forEach(p => povProducts(p).forEach(x => set.add(x)));
    return ['All', ...Array.from(set).sort()];
  }, [povs, cfg]);

  const filtered = useMemo(() => {
    return povs.filter(pov => {
      if (industryFilter !== 'All' && pov._account?.industry !== industryFilter) return false;
      if (outcomeFilter === 'Win' && !isWin(pov.win_loss)) return false;
      if (outcomeFilter === 'Loss' && !isLoss(pov.win_loss)) return false;
      if (outcomeFilter === 'Open' && pov.status === 'Closed') return false;
      if (productFilter !== 'All' && !povProducts(pov).includes(productFilter)) return false;
      return true;
    });
  }, [povs, industryFilter, outcomeFilter, productFilter, cfg]);

  const stats = useMemo(() => {
    const closed = filtered.filter(p => p.status === 'Closed');
    const wins = closed.filter(p => isWin(p.win_loss)).length;
    const losses = closed.filter(p => isLoss(p.win_loss)).length;
    const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null;
    const durations = filtered.map(deriveDuration).filter(d => d !== null);
    const avgDuration = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    return { winRate, avgDuration, total: filtered.length, wins };
  }, [filtered]);

  return (
    <div className="p-6 max-w-[1200px] mx-auto flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">POV Library</h1>
          <p className="text-[12px] text-text-muted mt-0.5">All proof-of-value records across accounts</p>
        </div>
        <span className="text-[11px] text-text-muted">{filtered.length} record{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-lg px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-text-dim">Industry</span>
          <select value={industryFilter} onChange={e => setIndustryFilter(e.target.value)}
            className="bg-[#10141b] border border-border rounded text-[11px] px-2 py-1 text-text-primary focus:outline-none focus:border-accent-blue/50">
            {industries.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-text-dim">Product</span>
          <select value={productFilter} onChange={e => setProductFilter(e.target.value)}
            className="bg-[#10141b] border border-border rounded text-[11px] px-2 py-1 text-text-primary focus:outline-none focus:border-accent-blue/50">
            {productOptions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-text-dim">Outcome</span>
          <div className="flex gap-1">
            {['All', 'Win', 'Loss', 'Open'].map(opt => (
              <button key={opt} onClick={() => setOutcomeFilter(opt)}
                className={`text-[10px] px-2 py-1 rounded border transition ${outcomeFilter === opt ? 'bg-accent-blue/15 text-accent-blue border-accent-blue/30' : 'bg-[#10141b] text-text-muted border-border hover:text-text-primary'}`}>
                {opt}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="rounded-lg border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-[12px] text-accent-red">{error}</div>}
      {loading && <div className="rounded-lg border border-border px-4 py-8 text-center text-[12px] text-text-muted">Loading POVs…</div>}
      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-[12px] text-text-dim">No POVs match.</div>
      )}

      {/* card grid */}
      {!loading && !error && filtered.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(pov => (
            <PovCard key={pov.id} pov={pov} version={versionOf[pov.id]}
              products={povProducts(pov)} deployment={povDeployment(pov)} useCases={povUseCases(pov)}
              onClick={() => setPreview(pov)} onDelete={deletePov} />
          ))}
        </div>
      )}

      {/* stats */}
      {!loading && !error && filtered.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Metric label="Win rate" value={stats.winRate !== null ? `${stats.winRate}%` : '—'} />
          <Metric label="Avg duration" value={stats.avgDuration !== null ? `${stats.avgDuration}d` : '—'} />
          <Metric label="Technical wins" value={stats.wins} />
        </div>
      )}

      {preview && <PreviewDrawer pov={preview} version={versionOf[preview.id]} onClose={() => setPreview(null)} navigate={navigate} onDelete={deletePov} />}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3 flex flex-col gap-1">
      <span className="text-[18px] font-semibold text-text-primary">{value}</span>
      <span className="text-[10px] uppercase tracking-wider text-text-dim">{label}</span>
    </div>
  );
}
