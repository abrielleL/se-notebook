import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import Card, { CardHeader } from '../components/Card.jsx';
import Icon from '../components/Icons.jsx';
import { formatDate } from '../lib/stage.js';
import { POV_STATUSES } from '../lib/constants.js';

// ─── Static OPSWAT product list for filter options ───────────────────────────
const OPSWAT_PRODUCTS = [
  'MetaDefender Core',
  'MetaDefender Kiosk',
  'MetaDefender Drive',
  'MetaDefender Cloud',
  'MetaDefender Email',
  'MetaDefender ICAP',
  'MetaAccess',
  'NetWall',
  'Filescan',
  'OTfuse',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safely get all text from a pov's section_texts as a single lowercased string. */
function sectionText(pov) {
  try {
    const st = pov?.section_texts;
    if (!st || typeof st !== 'object') return '';
    return Object.values(st).filter(Boolean).join(' ').toLowerCase();
  } catch {
    return '';
  }
}

/** Derive best-effort product names from section_texts. Returns array of strings. */
function deriveProducts(pov) {
  try {
    const text = sectionText(pov);
    if (!text) return [];
    return OPSWAT_PRODUCTS.filter((p) => text.includes(p.toLowerCase()));
  } catch {
    return [];
  }
}

/** Derive best-effort deployment type from section_texts. */
function deriveDeployment(pov) {
  try {
    const text = sectionText(pov);
    if (!text) return null;
    if (text.includes('air-gap') || text.includes('air gap') || text.includes('airgap')) return 'Air-gapped';
    if (text.includes('hybrid')) return 'Hybrid';
    if (text.includes('cloud')) return 'Cloud';
    if (text.includes('on-prem') || text.includes('on prem') || text.includes('on-premises')) return 'On-prem';
    return null;
  } catch {
    return null;
  }
}

/** Duration in days between start_date and end_date, or null. */
function deriveDuration(pov) {
  try {
    if (!pov?.start_date || !pov?.end_date) return null;
    const s = new Date(pov.start_date);
    const e = new Date(pov.end_date);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
    const days = Math.round((e - s) / (1000 * 60 * 60 * 24));
    return days >= 0 ? days : null;
  } catch {
    return null;
  }
}

/** Status badge color */
function statusColor(status) {
  switch (status) {
    case 'Draft':       return { bg: '#10141b', text: '#8b949e', border: '#1e2530' };
    case 'Sent':        return { bg: '#1a2744', text: '#58a6ff', border: '#1e3a6e' };
    case 'Kicked Off':  return { bg: '#2d2200', text: '#e3b341', border: '#4a3800' };
    case 'In Progress': return { bg: '#0d2a1a', text: '#3fb950', border: '#1a4a2a' };
    case 'Closed':      return { bg: '#2d0d0d', text: '#f85149', border: '#4a1a1a' };
    default:            return { bg: '#10141b', text: '#8b949e', border: '#1e2530' };
  }
}

/** Compute top keyword frequency across all pov section_texts for a given word list. */
function topKeyword(povs, keywords) {
  try {
    const counts = {};
    for (const pov of povs) {
      const text = sectionText(pov);
      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) {
          counts[kw] = (counts[kw] || 0) + 1;
        }
      }
    }
    const entries = Object.entries(counts);
    if (!entries.length) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  } catch {
    return null;
  }
}

const USE_CASE_KEYWORDS = [
  'data loss prevention', 'dlp', 'malware prevention', 'threat detection',
  'zero-day', 'content disarm', 'cdr', 'compliance', 'supply chain',
  'usb security', 'removable media', 'ot security', 'network security',
  'email security', 'cloud security', 'vulnerability', 'sandbox',
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function Badge({ label }) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border"
      style={{
        background: '#1a2744',
        color: '#58a6ff',
        borderColor: '#1e3a6e',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      {label}
    </span>
  );
}

function StatusBadge({ status }) {
  const c = statusColor(status);
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border"
      style={{ background: c.bg, color: c.text, borderColor: c.border, fontFamily: 'JetBrains Mono, monospace' }}
    >
      {status}
    </span>
  );
}

function MetricCard({ label, value }) {
  return (
    <div
      className="flex flex-col gap-1 px-4 py-3 rounded-lg border"
      style={{ background: '#0d1117', borderColor: '#1e2530' }}
    >
      <span className="text-[10px] uppercase tracking-wider" style={{ color: '#4a5568', fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </span>
      <span className="text-[18px] font-semibold" style={{ color: '#e6edf3', fontFamily: 'JetBrains Mono, monospace' }}>
        {value}
      </span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function PovLibrary() {
  const navigate = useNavigate();

  // ── Data state ──────────────────────────────────────────────────────────────
  const [povs, setPovs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ── Filter state ────────────────────────────────────────────────────────────
  const [selectedProducts, setSelectedProducts] = useState([]); // multi-select
  const [outcomeFilter, setOutcomeFilter] = useState('All');    // All | Win | Loss | Open
  const [industryFilter, setIndustryFilter] = useState('All');

  // ── Local win/loss overrides (optimistic update) ─────────────────────────────
  const [winLossOverrides, setWinLossOverrides] = useState({}); // { povId: value }

  // ── Load data ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.listAccounts()
      .then((accts) => {
        if (cancelled) return;
        const safeAccts = Array.isArray(accts) ? accts : [];
        return Promise.all(
          safeAccts.map((a) =>
            api.listPov(a.id)
              .then((list) => (Array.isArray(list) ? list : []).map((p) => ({ ...p, _account: a })))
              .catch(() => [])
          )
        ).then((nested) => {
          if (cancelled) return;
          setPovs(nested.flat());
          setLoading(false);
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.message || 'Failed to load POVs');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, []);

  // ── Derived filter options ───────────────────────────────────────────────────
  const industries = useMemo(() => {
    const set = new Set();
    for (const p of povs) {
      const ind = p._account?.industry;
      if (ind) set.add(ind);
    }
    return ['All', ...Array.from(set).sort()];
  }, [povs]);

  // ── Filtered rows ───────────────────────────────────────────────────────────
  const filteredPovs = useMemo(() => {
    return povs.filter((pov) => {
      // Industry filter
      if (industryFilter !== 'All') {
        if (pov._account?.industry !== industryFilter) return false;
      }

      // Outcome filter
      const effectiveWinLoss = winLossOverrides[pov.id] !== undefined
        ? winLossOverrides[pov.id]
        : pov.win_loss;
      if (outcomeFilter === 'Win' && effectiveWinLoss !== 'Win') return false;
      if (outcomeFilter === 'Loss' && effectiveWinLoss !== 'Loss') return false;
      if (outcomeFilter === 'Open' && pov.status === 'Closed') return false;

      // Product filter (multi-select OR logic)
      if (selectedProducts.length > 0) {
        const derived = deriveProducts(pov);
        const hasMatch = selectedProducts.some((sp) => derived.includes(sp));
        if (!hasMatch) return false;
      }

      return true;
    });
  }, [povs, industryFilter, outcomeFilter, selectedProducts, winLossOverrides]);

  // ── Stats from filtered rows ─────────────────────────────────────────────────
  const stats = useMemo(() => {
    const closed = filteredPovs.filter((p) => p.status === 'Closed');
    const wins = closed.filter((p) => {
      const wl = winLossOverrides[p.id] !== undefined ? winLossOverrides[p.id] : p.win_loss;
      return wl === 'Win';
    });
    const losses = closed.filter((p) => {
      const wl = winLossOverrides[p.id] !== undefined ? winLossOverrides[p.id] : p.win_loss;
      return wl === 'Loss';
    });

    const winRate = wins.length + losses.length > 0
      ? Math.round((wins.length / (wins.length + losses.length)) * 100)
      : null;

    const durations = filteredPovs.map(deriveDuration).filter((d) => d !== null);
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    const topProduct = topKeyword(filteredPovs, OPSWAT_PRODUCTS);
    const topUseCase = topKeyword(filteredPovs, USE_CASE_KEYWORDS);

    return { winRate, avgDuration, topProduct, topUseCase };
  }, [filteredPovs, winLossOverrides]);

  // ── Win/loss update handler ──────────────────────────────────────────────────
  async function handleWinLossChange(pov, value) {
    const newVal = value === '' ? null : value;
    setWinLossOverrides((prev) => ({ ...prev, [pov.id]: newVal }));
    try {
      await api.updatePov(pov.account_id, pov.id, { win_loss: newVal });
    } catch {
      // Revert on error
      setWinLossOverrides((prev) => ({ ...prev, [pov.id]: pov.win_loss }));
    }
  }

  // ── Product multi-select toggle ──────────────────────────────────────────────
  function toggleProduct(product) {
    setSelectedProducts((prev) =>
      prev.includes(product) ? prev.filter((p) => p !== product) : [...prev, product]
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div
      className="min-h-screen p-6 flex flex-col gap-4"
      style={{ background: '#0d1117', fontFamily: 'JetBrains Mono, monospace' }}
    >
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[14px] font-semibold" style={{ color: '#e6edf3' }}>
            POV Library
          </h1>
          <p className="text-[11px] mt-0.5" style={{ color: '#8b949e' }}>
            All proof-of-value records across accounts
          </p>
        </div>
        <span className="text-[11px] px-2 py-1 rounded border" style={{ color: '#8b949e', borderColor: '#1e2530', background: '#0d1117' }}>
          {filteredPovs.length} record{filteredPovs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Filter row */}
      <div
        className="rounded-lg border px-4 py-3 flex flex-wrap items-center gap-3"
        style={{ background: '#0d1117', borderColor: '#1e2530' }}
      >
        {/* Industry dropdown */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider" style={{ color: '#4a5568' }}>Industry</span>
          <select
            value={industryFilter}
            onChange={(e) => setIndustryFilter(e.target.value)}
            className="rounded border text-[11px] px-2 py-1 outline-none"
            style={{
              background: '#10141b',
              borderColor: '#1e2530',
              color: '#e6edf3',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            {industries.map((ind) => (
              <option key={ind} value={ind}>{ind}</option>
            ))}
          </select>
        </div>

        {/* Outcome filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider" style={{ color: '#4a5568' }}>Outcome</span>
          <div className="flex gap-1">
            {['All', 'Win', 'Loss', 'Open'].map((opt) => (
              <button
                key={opt}
                onClick={() => setOutcomeFilter(opt)}
                className="text-[10px] px-2 py-1 rounded border transition-colors"
                style={{
                  background: outcomeFilter === opt ? '#1a2744' : '#10141b',
                  borderColor: outcomeFilter === opt ? '#58a6ff' : '#1e2530',
                  color: outcomeFilter === opt ? '#58a6ff' : '#8b949e',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>

        {/* Product multi-select */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider" style={{ color: '#4a5568' }}>Products</span>
          <div className="flex flex-wrap gap-1">
            {OPSWAT_PRODUCTS.map((p) => {
              const active = selectedProducts.includes(p);
              return (
                <button
                  key={p}
                  onClick={() => toggleProduct(p)}
                  className="text-[10px] px-2 py-0.5 rounded border transition-colors"
                  style={{
                    background: active ? '#1a2744' : '#10141b',
                    borderColor: active ? '#58a6ff' : '#1e2530',
                    color: active ? '#58a6ff' : '#8b949e',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}
                >
                  {p}
                </button>
              );
            })}
            {selectedProducts.length > 0 && (
              <button
                onClick={() => setSelectedProducts([])}
                className="text-[10px] px-2 py-0.5 rounded border"
                style={{ background: '#10141b', borderColor: '#1e2530', color: '#4a5568', fontFamily: 'JetBrains Mono, monospace' }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div
          className="rounded-lg border px-4 py-3 text-[11px]"
          style={{ background: '#2d0d0d', borderColor: '#4a1a1a', color: '#f85149' }}
        >
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div
          className="rounded-lg border px-4 py-8 flex items-center justify-center text-[11px]"
          style={{ background: '#0d1117', borderColor: '#1e2530', color: '#8b949e' }}
        >
          Loading POVs…
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filteredPovs.length === 0 && (
        <div
          className="rounded-lg border px-4 py-12 flex items-center justify-center text-[12px]"
          style={{ background: '#0d1117', borderColor: '#1e2530', color: '#8b949e' }}
        >
          No POVs yet.
        </div>
      )}

      {/* Main table */}
      {!loading && !error && filteredPovs.length > 0 && (
        <Card>
          <CardHeader title="POV Records" subtitle={`${filteredPovs.length} result${filteredPovs.length !== 1 ? 's' : ''}`} />

          {/* Table header */}
          <div
            className="grid border-b px-4 py-2"
            style={{
              gridTemplateColumns: '1.6fr 1.8fr 0.8fr 0.8fr 0.5fr 1.1fr 80px',
              borderColor: '#1e2530',
            }}
          >
            {['Account', 'Products', 'Deployment', 'Status', 'Duration', 'Date Range', ''].map((h) => (
              <span
                key={h}
                className="text-[10px] uppercase tracking-wider"
                style={{ color: '#4a5568', fontFamily: 'JetBrains Mono, monospace' }}
              >
                {h}
              </span>
            ))}
          </div>

          {/* Table rows */}
          {filteredPovs.map((pov, idx) => {
            const products = deriveProducts(pov);
            const deployment = deriveDeployment(pov);
            const duration = deriveDuration(pov);
            const isClosed = pov.status === 'Closed';
            const effectiveWinLoss = winLossOverrides[pov.id] !== undefined
              ? winLossOverrides[pov.id]
              : pov.win_loss;
            const isLast = idx === filteredPovs.length - 1;

            return (
              <div
                key={pov.id}
                className={`grid px-4 py-2.5 items-center hover:bg-white/[0.02] transition-colors ${!isLast ? 'border-b' : ''}`}
                style={{
                  gridTemplateColumns: '1.6fr 1.8fr 0.8fr 0.8fr 0.5fr 1.1fr 80px',
                  borderColor: '#1e2530',
                }}
              >
                {/* Account */}
                <div className="min-w-0">
                  <div className="text-[11px] font-medium truncate" style={{ color: '#e6edf3' }}>
                    {pov._account?.account_name || '—'}
                  </div>
                  {pov._account?.industry && (
                    <div className="text-[10px] truncate mt-0.5" style={{ color: '#4a5568' }}>
                      {pov._account.industry}
                    </div>
                  )}
                </div>

                {/* Products */}
                <div className="flex flex-wrap gap-1 min-w-0">
                  {products.length > 0
                    ? products.slice(0, 3).map((p) => <Badge key={p} label={p} />)
                    : <span className="text-[10px]" style={{ color: '#4a5568' }}>—</span>
                  }
                  {products.length > 3 && (
                    <span className="text-[10px]" style={{ color: '#8b949e' }}>+{products.length - 3}</span>
                  )}
                </div>

                {/* Deployment */}
                <div className="text-[11px]" style={{ color: deployment ? '#e6edf3' : '#4a5568' }}>
                  {deployment || '—'}
                </div>

                {/* Status + win/loss inline */}
                <div className="flex flex-col gap-1">
                  <StatusBadge status={pov.status} />
                  {isClosed && (
                    <select
                      value={effectiveWinLoss || ''}
                      onChange={(e) => handleWinLossChange(pov, e.target.value)}
                      className="rounded border text-[10px] px-1.5 py-0.5 outline-none"
                      style={{
                        background: effectiveWinLoss === 'Win' ? '#0d2a1a' : effectiveWinLoss === 'Loss' ? '#2d0d0d' : '#10141b',
                        borderColor: effectiveWinLoss === 'Win' ? '#3fb950' : effectiveWinLoss === 'Loss' ? '#f85149' : '#1e2530',
                        color: effectiveWinLoss === 'Win' ? '#3fb950' : effectiveWinLoss === 'Loss' ? '#f85149' : '#8b949e',
                        fontFamily: 'JetBrains Mono, monospace',
                        maxWidth: '80px',
                      }}
                    >
                      <option value="">—</option>
                      <option value="Win">Win</option>
                      <option value="Loss">Loss</option>
                    </select>
                  )}
                </div>

                {/* Duration */}
                <div className="text-[11px]" style={{ color: duration !== null ? '#e6edf3' : '#4a5568' }}>
                  {duration !== null ? `${duration}d` : '—'}
                </div>

                {/* Date range */}
                <div className="text-[10px]" style={{ color: '#8b949e', fontFamily: 'JetBrains Mono, monospace' }}>
                  {pov.start_date || pov.end_date
                    ? `${formatDate(pov.start_date) || '?'} – ${formatDate(pov.end_date) || '?'}`
                    : '—'
                  }
                </div>

                {/* Open button */}
                <div>
                  <button
                    onClick={() => navigate(`/accounts/${pov.account_id}/pov-generator/${pov.id}`)}
                    className="text-[10px] px-2.5 py-1 rounded border transition-colors hover:border-[#58a6ff] hover:text-[#58a6ff]"
                    style={{
                      background: '#10141b',
                      borderColor: '#1e2530',
                      color: '#8b949e',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    Open →
                  </button>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {/* Stats bar */}
      {!loading && !error && filteredPovs.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label="Win Rate"
            value={stats.winRate !== null ? `${stats.winRate}%` : '—'}
          />
          <MetricCard
            label="Avg Duration"
            value={stats.avgDuration !== null ? `${stats.avgDuration}d` : '—'}
          />
          <MetricCard
            label="Top Product"
            value={stats.topProduct || '—'}
          />
          <MetricCard
            label="Top Use Case"
            value={stats.topUseCase || '—'}
          />
        </div>
      )}
    </div>
  );
}
