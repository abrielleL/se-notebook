import { parseDbDate } from './stage.js';

// Calendar quarters — Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec.
//
// "Working this quarter" is derived from note/transcript activity, not from
// close_date: no account in this notebook carries a close date, so a
// forecast-style filter would render an empty board. Activity is the signal
// that actually exists, and it's the honest one for a presales notebook —
// an account you've written a note on this quarter is one you're working.
export function currentQuarter(now = new Date()) {
  const q = Math.floor(now.getMonth() / 3);          // 0..3
  const year = now.getFullYear();
  return {
    q: q + 1,
    year,
    label: `Q${q + 1} ${year}`,
    // Local midnight on the first day, through the last moment of the last day.
    start: new Date(year, q * 3, 1),
    end: new Date(year, q * 3 + 3, 0, 23, 59, 59, 999)
  };
}

// Short human range, e.g. "Jul 1 – Sep 30".
export function quarterRangeLabel(quarter) {
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(quarter.start)} – ${fmt(quarter.end)}`;
}

// Did this account see any activity inside the quarter? last_note_date is the
// most recent note on the account (the list endpoint computes it), so an
// account whose newest note predates the quarter counts as not being worked.
export function workedInQuarter(account, quarter) {
  const d = parseDbDate(account?.last_note_date);
  return !!d && d >= quarter.start && d <= quarter.end;
}
