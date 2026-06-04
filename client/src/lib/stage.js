// NOTE: presales stages now live in lib/stages.js. The old generic stage list
// and styles were removed from here.

export function initials(name = '') {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const PALETTE = ['#58a6ff', '#bc8cff', '#3fb950', '#e3b341', '#f0883e', '#26a641', '#f85149'];

export function colorForName(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function formatDate(d) {
  if (!d) return '';
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return d;
  }
}

export function formatShortDate(d) {
  if (!d) return { day: '', month: '' };
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return { day: '', month: '' };
  return {
    day: String(dt.getDate()),
    month: dt.toLocaleDateString('en-US', { month: 'short' })
  };
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// --- react-datepicker boundary helpers ---
// Form/API values stay as 'YYYY-MM-DD' strings; convert only at the picker.
// Parse as LOCAL midnight (and format from local components) so the displayed
// day never shifts across time zones.
export function parseISODate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const d = new Date(`${value}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

export function toISODate(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
