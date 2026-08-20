// NOTE: presales stages now live in lib/stages.js. The old generic stage list
// and styles were removed from here.

export function initials(name = '') {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const PALETTE = ['#5c9bff', '#8f47e8', '#4fd15c', '#ff9a4d', '#ff9a4d', '#4fd15c', '#ff6b66'];

export function colorForName(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Turn a value out of the database into a Date that displays the day the user
// actually means. Two traps, both of which showed up as dates rendering one day
// early west of UTC:
//
//   'YYYY-MM-DD'          -> new Date() reads this as UTC midnight, then
//                            toLocaleDateString renders it in local time, so
//                            2026-06-18 displayed as "Jun 17" at UTC-4. Parse
//                            as LOCAL midnight instead (same trick parseISODate
//                            already used).
//   'YYYY-MM-DD HH:MM:SS' -> SQLite CURRENT_TIMESTAMP is UTC but carries no
//                            timezone marker, so new Date() reads it as local
//                            and shifts it by the offset. Mark it as UTC.
export function parseDbDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    const d = new Date(`${s.replace(' ', 'T')}Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);   // already carries an offset (ISO with Z or +hh:mm)
  return isNaN(d.getTime()) ? null : d;
}

export function formatDate(d) {
  if (!d) return '';
  const dt = parseDbDate(d);
  if (!dt) return typeof d === 'string' ? d : '';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatShortDate(d) {
  if (!d) return { day: '', month: '' };
  const dt = parseDbDate(d);
  if (!dt) return { day: '', month: '' };
  return {
    day: String(dt.getDate()),
    month: dt.toLocaleDateString('en-US', { month: 'short' })
  };
}

// The LOCAL calendar date. toISOString() would give the UTC date, which after
// ~20:00 local (UTC-4) is already tomorrow -- an evening note got tomorrow's date.
export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
