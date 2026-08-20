// ---------------------------------------------------------------------------
// LinkedIn profile links.
//
// Deliberately no API client here. LinkedIn has no endpoint that returns
// another member's profile: the Profile API is partner-gated and its terms
// forbid storing data for anyone but the authenticated member, and scraping
// breaches the User Agreement (the case that shut down Proxycurl in 2025).
//
// So the notebook only ever stores a URL the user supplies and builds links
// they open themselves. Nothing in this file makes a network request.
// ---------------------------------------------------------------------------

// Tracking junk LinkedIn appends when you copy a profile URL from the app.
const STRIP_PARAMS = new Set([
  'trk', 'trkInfo', 'originalSubdomain', 'original_referer', 'lipi', 'licu',
  'miniProfileUrn', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content'
]);

// Accepts what a person realistically pastes -- a bare host, a full URL, a
// mobile link, a Sales Navigator lead URL -- and returns a clean canonical URL,
// or null when it isn't a LinkedIn link at all.
function normalizeLinkedInUrl(input) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) return null;

  // Tolerate a pasted host with no scheme ("linkedin.com/in/jane").
  if (!/^https?:\/\//i.test(raw)) {
    if (!/^([a-z0-9-]+\.)*linkedin\.com\//i.test(raw)) return null;
    raw = `https://${raw}`;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  // Accept linkedin.com and its country subdomains (uk.linkedin.com, etc.).
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;

  for (const p of [...url.searchParams.keys()]) {
    if (STRIP_PARAMS.has(p)) url.searchParams.delete(p);
  }

  // Canonical host, no trailing slash. Path case is preserved: LinkedIn
  // vanity slugs are case-insensitive but the original reads better.
  url.protocol = 'https:';
  url.hostname = 'www.linkedin.com';
  url.hash = '';
  let out = url.toString().replace(/\/$/, '');
  return out.length <= 500 ? out : null;
}

// Is this a personal profile (/in/...) rather than a company or post link?
function isProfileUrl(url) {
  return /^https:\/\/www\.linkedin\.com\/(in|sales\/lead|sales\/people)\//i.test(url || '');
}

// A people-search deep link for a contact we don't have a URL for yet. The
// user opens this in their own logged-in session; we never request it.
function searchUrl({ name, org_name, title } = {}) {
  const terms = [name, org_name || title].filter(Boolean).join(' ').trim();
  if (!terms) return null;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(terms)}`;
}

module.exports = { normalizeLinkedInUrl, isProfileUrl, searchUrl };
