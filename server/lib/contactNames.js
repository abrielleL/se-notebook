// ---------------------------------------------------------------------------
// Contact name normalization + duplicate detection.
//
// Contact rows used to be deduped on `LOWER(name)` alone, which let every
// spelling of a person become its own row: "Erika Pinczesi" / "Erika Pinczesi -",
// "Ahmad, Tasneem" / "Tasneem Ahmad", "Nima" / "Nima Gharehdaghi". Everything
// here exists to collapse those into one identity.
//
// Two layers:
//   1. normalizeName()  -> the display name we actually store (cleaned up).
//   2. nameKey()        -> a folded key used for exact-match dedupe, backed by
//                          a UNIQUE(account_id, name_key) index in the DB.
//
// A third layer (isLikelySameName / similarity) handles the cases a key can't:
// misspellings and first-name-only fragments. Those never merge silently at
// write time -- they go to the review queue.
// ---------------------------------------------------------------------------

// Honorifics and credential suffixes that aren't part of the identity.
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'rev', 'capt', 'lt', 'sgt']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'phd', 'md', 'mba', 'cissp', 'cisa', 'cism', 'pe', 'esq']);

// Strip accents so "José" and "Jose" share a key.
function foldDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Collapse every flavor of unicode whitespace/quote/dash to a plain ASCII form.
// Transcript exports are full of NBSP, curly apostrophes and en-dashes.
function foldPunctuation(s) {
  return String(s)
    .replace(/[  -​  　﻿]/g, ' ') // exotic spaces -> space
    .replace(/[‘’ʼ′`´]/g, "'")                   // curly quotes -> '
    .replace(/[–—―−]/g, '-');                    // dashes -> -
}

// Remove trailing/leading separator debris left behind when a "Name - Title"
// line was split and the title half came back empty ("Erika Pinczesi -").
function trimSeparators(s) {
  return String(s)
    .replace(/^[\s\-–—_:,.;|/\\]+/, '')
    .replace(/[\s\-–—_:,.;|/\\]+$/, '')
    .trim();
}

// "Ahmad, Tasneem" -> "Tasneem Ahmad". Only fires on a single comma with a
// plausible name on each side, so "Smith, VP of Security" is left alone (the
// right side looks like a title, not a given name).
function reorderLastFirst(s) {
  const parts = s.split(',');
  if (parts.length !== 2) return s;
  const last = parts[0].trim();
  const first = parts[1].trim();
  if (!last || !first) return s;
  // Both halves must look like name tokens: <= 3 words, letters/hyphens/periods
  // only, and the right half must not contain an obvious title keyword.
  const nameish = /^[A-Za-z][A-Za-z'’\-.]*(\s+[A-Za-z][A-Za-z'’\-.]*){0,2}$/;
  if (!nameish.test(last) || !nameish.test(first)) return s;
  if (/\b(vp|director|manager|engineer|analyst|ciso|cto|cio|ceo|chief|head|lead|admin|president|officer|architect|specialist|consultant|supervisor)\b/i.test(first)) return s;
  return `${first} ${last}`;
}

// Drop a trailing parenthetical, which is nearly always company or role
// context rather than part of the name ("Ron Howell (Guidepoint)").
function stripParenthetical(s) {
  return s.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// Split into tokens with honorifics/suffixes removed.
function nameTokens(s) {
  return s
    .split(/\s+/)
    .map(t => t.replace(/[.,]$/g, ''))
    .filter(Boolean)
    .filter(t => !HONORIFICS.has(t.toLowerCase().replace(/\./g, '')))
    .filter(t => !SUFFIXES.has(t.toLowerCase().replace(/\./g, '')));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// The cleaned-up name we store and display. Returns '' for anything unusable.
function normalizeName(raw) {
  if (!raw) return '';
  let s = foldPunctuation(raw);
  s = s.replace(/\s+/g, ' ').trim();
  s = trimSeparators(s);
  s = stripParenthetical(s);
  s = trimSeparators(s);
  s = reorderLastFirst(s);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s || s.length > 80) return '';
  // Must contain at least one letter; rejects "---", "1", ":" etc.
  if (!/[A-Za-z]/.test(s)) return '';
  return s;
}

// The dedupe key: normalized name, diacritics folded, punctuation removed,
// honorifics/suffixes dropped, lowercased, single-spaced. Middle initials are
// dropped so "Michael C Prados" and "Michael Prados" collide.
function nameKey(raw) {
  const norm = normalizeName(raw);
  if (!norm) return '';
  let tokens = nameTokens(foldDiacritics(norm).toLowerCase())
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  // Drop single-letter middle initials when there are >= 3 tokens.
  if (tokens.length >= 3) {
    tokens = tokens.filter((t, i) => !(i > 0 && i < tokens.length - 1 && t.length === 1));
  }
  return tokens.join(' ');
}

// How many name tokens the value carries. 1 => first-name-only fragment, which
// is what transcript speaker labels ("Paul:", "Nima:") produce.
function tokenCount(raw) {
  const norm = normalizeName(raw);
  return norm ? nameTokens(norm).length : 0;
}

// Levenshtein distance, capped for early exit.
function editDistance(a, b, cap = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Classify the relationship between two names. Returns null when they look
// like different people, otherwise { reason, score, confident }.
//
// `confident: true` means safe to merge without human review:
//   - identical keys
//   - same token count with only a small spelling drift in one token
// `confident: false` means "probably the same person, ask first":
//   - a first-name fragment matching the first name of a fuller name
//   - larger spelling drift
function compareNames(a, b) {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return null;
  if (ka === kb) return { reason: 'identical_key', score: 1, confident: true };

  const ta = ka.split(' ');
  const tb = kb.split(' ');

  // One name is a single token: treat as a fragment of the other when it
  // matches that name's first token. Never auto-merge -- "Michael" could be a
  // different Michael.
  if (ta.length === 1 || tb.length === 1) {
    const [short, long] = ta.length === 1 ? [ta, tb] : [tb, ta];
    if (long.length > 1 && short[0] === long[0]) {
      return { reason: 'first_name_fragment', score: 0.6, confident: false };
    }
    // Fragment vs a near-miss first name ("seema" / "sima kasiri"). Queued for
    // review only -- a 2-char drift on a short token is far too loose to trust.
    if (long.length > 1 && short[0].length >= 4 && editDistance(short[0], long[0], 2) <= 2) {
      return { reason: 'first_name_fragment_fuzzy', score: 0.45, confident: false };
    }
    return null;
  }

  // Same number of tokens: allow drift in exactly one token.
  if (ta.length === tb.length) {
    let differing = -1;
    let diffs = 0;
    for (let i = 0; i < ta.length; i++) {
      if (ta[i] !== tb[i]) { diffs++; differing = i; }
    }
    if (diffs === 1) {
      const x = ta[differing];
      const y = tb[differing];
      const d = editDistance(x, y, 3);
      const longer = Math.max(x.length, y.length);
      // A 1-char drift in a token of >= 5 chars is a typo, not a new person
      // ("michael" / "micheal", "ohara" / "ohara" after apostrophe folding).
      if (d === 1 && longer >= 5) {
        return { reason: 'typo_one_char', score: 0.9, confident: true };
      }
      if (d <= 2 && longer >= 7) {
        return { reason: 'spelling_variant', score: 0.7, confident: false };
      }
      // Same last name, first name is an initial or shortened form.
      if (differing === 0 && (x.startsWith(y) || y.startsWith(x)) && Math.min(x.length, y.length) >= 1) {
        return { reason: 'shortened_first_name', score: 0.55, confident: false };
      }
      return null;
    }
    // Token order swapped ("tasneem ahmad" / "ahmad tasneem") -- the
    // reorderLastFirst heuristic can't catch a comma-less swap.
    if (diffs === 2 && [...ta].sort().join(' ') === [...tb].sort().join(' ')) {
      return { reason: 'token_order', score: 0.85, confident: true };
    }
    return null;
  }

  // Different token counts, both multi-token: a subset match means one is
  // probably missing a middle name ("magdy michael" / "magdy paul michael").
  const setA = new Set(ta);
  const setB = new Set(tb);
  const [small, large] = ta.length < tb.length ? [ta, tb] : [tb, ta];
  const contained = small.every(t => (small === ta ? setB : setA).has(t));
  if (contained && small[0] === large[0] && small[small.length - 1] === large[large.length - 1]) {
    return { reason: 'subset_name', score: 0.75, confident: false };
  }
  return null;
}

module.exports = {
  normalizeName,
  nameKey,
  tokenCount,
  compareNames,
  editDistance
};
