// ---------------------------------------------------------------------------
// Account Executive roster.
//
// Accounts are typically written down with just the AE's first name. The
// roster holds the full names, and resolveAeName() expands a first name into
// one when the match is unambiguous -- so "Rob" saved on an account becomes
// "Rob Emmerich", and exports stop carrying half a name.
//
// Expansion is deliberately conservative: it only fires when exactly one
// person on the roster can be meant. Two Robs, or a name nobody recognises,
// is left exactly as typed. Guessing here would quietly put the wrong AE on a
// customer-facing document.
// ---------------------------------------------------------------------------

const db = require('../db/database');

const fold = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
const firstNameOf = (full) => fold(full).split(' ')[0] || '';

function listRoster() {
  return db.prepare('SELECT * FROM ae_roster ORDER BY sort_order ASC, full_name ASC').all();
}

// Returns the canonical full name for what someone typed, or the input
// unchanged (trimmed) when no single roster entry matches.
function resolveAeName(input, roster = null) {
  const typed = String(input == null ? '' : input).trim().replace(/\s+/g, ' ');
  if (!typed) return null;

  const names = (roster || listRoster()).map(r => r.full_name);

  // Already a full name we know -- adopt the roster's spelling and casing.
  const exact = names.find(n => fold(n) === fold(typed));
  if (exact) return exact;

  // A single token is a first name; expand it only if one person owns it.
  if (!typed.includes(' ')) {
    const matches = names.filter(n => firstNameOf(n) === fold(typed));
    if (matches.length === 1) return matches[0];
  }

  return typed;
}

module.exports = { listRoster, resolveAeName, fold, firstNameOf };
