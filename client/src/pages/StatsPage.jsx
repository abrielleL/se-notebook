import { useEffect, useState, useMemo } from 'react';
import { api } from '../lib/api.js';
import Card, { CardHeader } from '../components/Card.jsx';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { PRESALES_STAGES } from '../lib/constants.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function currentQuarterBounds() {
  const now = new Date();
  const y = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3);
  const start = new Date(y, q * 3, 1);
  const end = new Date(y, q * 3 + 3, 1);
  return { start, end };
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round(Math.abs(b - a) / 86400000);
}

const PRODUCT_KEYWORDS = [
  'MetaDefender Core',
  'Kiosk',
  'ICAP',
  'Email Gateway',
  'Storage Security',
  'MFT',
  'NAC',
  'OT Security',
  'Netwall',
  'Cloud',
  'Endpoint',
];

const USECASE_KEYWORDS = [
  'file upload',
  'removable media',
  'Deep CDR',
  'secure transfer',
  'storage scanning',
  'email scanning',
  'zero-day',
  'endpoint compliance',
  'OT visibility',
  'ICAP',
  'supply chain',
];

function countKeywordsInPov(pov, keywords) {
  const text = [
    pov.pov_text || '',
    ...Object.values(pov.section_texts || {}),
  ]
    .join(' ')
    .toLowerCase();

  return keywords.map((kw) => ({
    name: kw,
    count: (() => {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return (text.match(re) || []).length;
    })(),
  }));
}

function aggregateKeywords(povs, keywords) {
  const totals = {};
  for (const pov of povs) {
    const counts = countKeywordsInPov(pov, keywords);
    for (const { name, count } of counts) {
      totals[name] = (totals[name] || 0) + count;
    }
  }
  return Object.entries(totals)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));
}

// ── sub-components ───────────────────────────────────────────────────────────

function MetricCard({ label, value }) {
  return (
    <div className="bg-card border border-border rounded-lg px-5 py-4 flex flex-col gap-1 min-w-0">
      <span
        style={{
                    fontSize: 28,
          fontWeight: 600,
          color: '#f4f4f5',
          lineHeight: 1.1,
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 11, color: '#838892' }}>
        {label}
      </span>
    </div>
  );
}

function RankedList({ items, emptyLabel = 'Not enough data' }) {
  if (!items || items.length === 0) {
    return (
      <div
        className="px-4 py-3"
        style={{ fontSize: 11, color: '#616875' }}
      >
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="flex flex-col divide-y divide-border">
      {items.map(({ name, count }, i) => (
        <div
          key={name}
          className="flex items-center justify-between px-4 py-2 border border-border rounded mx-3 my-1.5"
          style={{ background: '#081938' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              style={{
                fontSize: 10,
                color: '#5c9bff',
                minWidth: 18,
              }}
            >
              {i + 1}.
            </span>
            <span
              className="truncate"
              style={{ fontSize: 11, color: '#f4f4f5' }}
            >
              {name}
            </span>
          </div>
          <span
            style={{
              fontSize: 10,
              color: '#838892',
              marginLeft: 8,
              flexShrink: 0,
            }}
          >
            {count}
          </span>
        </div>
      ))}
    </div>
  );
}

// Single-series magnitude chart: one hue, not a color per bar. Cycling hues
// across the bars of one series encodes position rather than identity, which
// reads as meaning that isn't there — and it burned status colors (red/amber)
// as decoration, next to a UI where those mean risk.
const BAR_FILL = '#1d6bfc';        // --opswat-primary
const BAR_FILL_MUTED = '#273454';  // --opswat-dark-100, for zero/empty stages

// ── main component ───────────────────────────────────────────────────────────

export default function StatsPage() {
  const [accts, setAccts] = useState(null);
  const [povs, setPovs] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const accounts = await api.listAccounts();
        if (cancelled) return;
        setAccts(accounts || []);

        const povArrays = await Promise.all(
          (accounts || []).map((a) =>
            api.listPov(a.id).catch(() => [])
          )
        );
        if (cancelled) return;
        setPovs(povArrays.flat());
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Failed to load data');
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── derived metrics ──────────────────────────────────────────────────────

  const metrics = useMemo(() => {
    if (!accts || !povs) return null;

    // POVs this quarter
    const { start, end } = currentQuarterBounds();
    const povsThisQuarter = povs.filter((p) => {
      const d = parseDate(p.generated_at);
      return d && d >= start && d < end;
    }).length;

    // Win rate
    const decided = povs.filter((p) => p.win_loss === 'win' || p.win_loss === 'loss');
    const wins = decided.filter((p) => p.win_loss === 'win').length;
    const winRate =
      decided.length > 0 ? `${Math.round((wins / decided.length) * 100)}%` : '—';

    // Avg duration
    const durations = povs
      .map((p) => daysBetween(parseDate(p.start_date), parseDate(p.end_date)))
      .filter((d) => d !== null);
    const avgDuration =
      durations.length > 0
        ? `${Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)}d`
        : '—';

    return {
      povsThisQuarter,
      winRate,
      avgDuration,
      totalAccounts: accts.length,
    };
  }, [accts, povs]);

  // ── chart data ───────────────────────────────────────────────────────────

  const stageChartData = useMemo(() => {
    if (!accts) return [];
    const counts = {};
    for (const a of accts) {
      const stage = a.presales_stage || null;
      const key = stage || '(unset)';
      counts[key] = (counts[key] || 0) + 1;
    }
    const rows = [];
    for (const stage of PRESALES_STAGES) {
      if (counts[stage]) rows.push({ stage, count: counts[stage] });
    }
    if (counts['(unset)']) rows.push({ stage: '(unset)', count: counts['(unset)'] });
    return rows;
  }, [accts]);

  // ── keyword rankings ─────────────────────────────────────────────────────

  const topProducts = useMemo(() => {
    if (!povs) return [];
    return aggregateKeywords(povs, PRODUCT_KEYWORDS);
  }, [povs]);

  const topUseCases = useMemo(() => {
    if (!povs) return [];
    return aggregateKeywords(povs, USECASE_KEYWORDS);
  }, [povs]);

  // ── render ───────────────────────────────────────────────────────────────

  const isLoading = accts === null || povs === null;

  if (error) {
    return (
      <div className="p-6">
        <p style={{ color: '#ff6b66', fontSize: 12 }}>Error: {error}</p>
      </div>
    );
  }

  return (
    <div
      className="p-6 flex flex-col gap-6 min-h-screen"
      style={{ background: '#081938' }}
    >
      {/* page header */}
      <div>
        <h1 style={{ fontSize: 16, fontWeight: 600, color: '#f4f4f5', margin: 0 }}>Stats</h1>
        <p style={{ fontSize: 11, color: '#838892', margin: '2px 0 0' }}>
          Computed locally from your notebook.
        </p>
      </div>

      {isLoading ? (
        <div style={{ fontSize: 11, color: '#838892' }}>Loading…</div>
      ) : (
        <>
          {/* top metric cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard label="POVs this quarter" value={metrics.povsThisQuarter} />
            <MetricCard label="Win rate" value={metrics.winRate} />
            <MetricCard label="Avg duration" value={metrics.avgDuration} />
            <MetricCard label="Total accounts" value={metrics.totalAccounts} />
          </div>

          {/* stage bar chart */}
          <Card>
            <CardHeader title="Accounts by stage" />
            {stageChartData.length === 0 ? (
              <div className="px-4 py-6" style={{ fontSize: 11, color: '#616875' }}>
                No accounts yet.
              </div>
            ) : (
              <div className="px-2 pt-3 pb-2">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart
                    data={stageChartData}
                    margin={{ top: 4, right: 12, left: -10, bottom: 40 }}
                  >
                    <XAxis
                      dataKey="stage"
                      tick={{ fill: '#838892', fontSize: 10 }}
                      axisLine={{ stroke: '#273454' }}
                      tickLine={false}
                      angle={-35}
                      textAnchor="end"
                      interval={0}
                    />
                    <YAxis
                      tick={{ fill: '#838892', fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(88,166,255,0.06)' }}
                      contentStyle={{
                        background: '#081938',
                        border: '1px solid #273454',
                        fontSize: 11,
                        color: '#f4f4f5',
                        borderRadius: 6,
                      }}
                      labelStyle={{ color: '#838892', marginBottom: 2 }}
                      itemStyle={{ color: '#f4f4f5' }}
                    />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={36}>
                      {stageChartData.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={entry.count ? BAR_FILL : BAR_FILL_MUTED}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* top products + top use cases */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader title="Top products" />
              <div className="py-2">
                <RankedList items={topProducts} />
              </div>
            </Card>

            <Card>
              <CardHeader title="Top use cases" />
              <div className="py-2">
                <RankedList items={topUseCases} />
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
