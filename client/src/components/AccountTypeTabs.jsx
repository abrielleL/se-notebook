import { ACCOUNT_TYPE_TABS } from '../lib/constants.js';

// Customers / Partners segmented control. Shared by the Accounts list and the
// Dashboard so both views split the same way and stay visually identical.
// `counts` is keyed by account type, e.g. { customer: 55, partner: 4 }.
export default function AccountTypeTabs({ value, onChange, counts = {} }) {
  return (
    <div className="inline-flex items-center gap-1 p-1 bg-card border border-border rounded-lg">
      {ACCOUNT_TYPE_TABS.map(t => {
        const active = value === t.value;
        return (
          <button
            key={t.value}
            onClick={() => onChange(t.value)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium transition"
            style={active
              ? { background: `${t.color}1f`, color: t.color, boxShadow: `inset 0 0 0 1px ${t.color}59` }
              : { color: '#838892' }}
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: active ? t.color : '#3a4460' }} />
            {t.label}
            <span className={`text-[11px] tabular-nums ${active ? 'opacity-70' : 'text-text-dim'}`}>
              {counts[t.value] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}
