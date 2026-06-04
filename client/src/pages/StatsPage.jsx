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
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 28,
          fontWeight: 600,
          color: '#e6edf3',
          lineHeight: 1.1,
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 11, color: '#8b949e', fontFamily: "'JetBrains Mono', monospace" }}>
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
        style={{ fontSize: 11, color: '#4a5568', fontFamily: "'JetBrains Mono', monospace" }}
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
          style={{ background: '#0d1117' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              style={{
                fontSize: 10,
                color: '#58a6ff',
                fontFamily: "'JetBrains Mono', monospace",
                minWidth: 18,
              }}
            >
              {i + 1}.
            </span>
            <span
              className="truncate"
              style={{ fontSize: 11, color: '#e6edf3', fontFamily: "'JetBrains Mono', monospace" }}
            >
              {name}
            </span>
          </div>
          <span
            style={{
              fontSize: 10,
              color: '#8b949e',
              fontFamily: "'JetBrains Mono', monospace",
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

const CHART_COLORS = [
  '#58a6ff',
  '#3fb950',
  '#e3b341',
  '#f85149',
  '#bc8cff',
  '#f0883e',
  '#58a6ff',
  '#3fb950',
  '#e3b341',
  '#f85149',
  '#bc8cff',
  '#f0883e',
];

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
      <div className="p-6" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        <p style={{ color: '#f85149', fontSize: 12 }}>Error: {error}</p>
      </div>
    );
  }

  return (
    <div
      className="p-6 flex flex-col gap-6 min-h-screen"
      style={{ background: '#0d1117', fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* page header */}
      <div>
        <h1 style={{ fontSize: 16, fontWeight: 600, color: '#e6edf3', margin: 0 }}>Stats</h1>
        <p style={{ fontSize: 11, color: '#8b949e', margin: '2px 0 0' }}>
          Computed locally from your notebook.
        </p>
      </div>

      {isLoading ? (
        <div style={{ fontSize: 11, color: '#8b949e' }}>Loading…</div>
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
              <div className="px-4 py-6" style={{ fontSize: 11, color: '#4a5568' }}>
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
                      tick={{ fill: '#8b949e', fontSize: 10 }}
                      axisLine={{ stroke: '#1e2530' }}
                      tickLine={false}
                      angle={-35}
                      textAnchor="end"
                      interval={0}
                    />
                    <YAxis
                      tick={{ fill: '#8b949e', fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(88,166,255,0.06)' }}
                      contentStyle={{
                        background: '#0d1117',
                        border: '1px solid #1e2530',
                        fontSize: 11,
                        color: '#e6edf3',
                        fontFamily: "'JetBrains Mono', monospace",
                        borderRadius: 6,
                      }}
                      labelStyle={{ color: '#8b949e', marginBottom: 2 }}
                      itemStyle={{ color: '#e6edf3' }}
                    />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={36}>
                      {stageChartData.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={CHART_COLORS[index % CHART_COLORS.length]}
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
