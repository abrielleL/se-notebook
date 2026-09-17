// ---------------------------------------------------------------------------
// Company profile, derived from the company's own public website.
//
// Unlike lib/linkedin.js -- which never makes a network request, because
// LinkedIn's terms forbid fetching another member's profile -- a company's own
// marketing site is public and meant to be read. We still keep the same
// restraint: one page (plus an About page if the homepage links to one), no
// crawling, robots.txt honored, and nothing stored but a short summary.
//
// The fetch target is a URL a user typed, and the request leaves from the
// server, so every hop is checked against the private address space before we
// connect. Without that, "http://169.254.169.254/" or "http://localhost:8000"
// in the website field would turn this into a way to read the host's own
// network.
// ---------------------------------------------------------------------------

const dns = require('dns').promises;
const net = require('net');

const FETCH_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 2 * 1024 * 1024;   // a marketing page that big is a bug
const MAX_TEXT_CHARS = 12000;             // ~3k tokens; see the cost estimate
// Identifies the tool honestly, but with the Mozilla/5.0 prefix that most
// corporate WAFs expect -- a bare tool name gets a 403 from a fair number of
// sites (OPSWAT's own among them). Some sites block it regardless; that path
// returns a clear message and the SE writes the profile by hand instead.
const USER_AGENT = 'Mozilla/5.0 (compatible; se-notebook/1.0; +company-profile-lookup)';

// Tracking junk that rides along on a pasted URL.
const STRIP_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'ref', 'source'
]);

// Accepts what someone realistically pastes -- a bare host, a full URL, a
// link with tracking params -- and returns a clean canonical URL, or null.
function normalizeWebsiteUrl(input) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // A hostname with no dot is either a local machine name or a typo; neither
  // is a company website.
  if (!url.hostname.includes('.')) return null;

  for (const p of [...url.searchParams.keys()]) {
    if (STRIP_PARAMS.has(p.toLowerCase())) url.searchParams.delete(p);
  }
  url.hash = '';
  return url.toString();
}

// --- private address space ------------------------------------------------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;   // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    // IPv4-mapped (::ffff:10.0.0.1) -- check the embedded address.
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

// Resolves the host and rejects anything that lands inside the private space.
// Called for every URL we're about to open, including each redirect hop.
async function assertPublicHost(urlStr) {
  const host = new URL(urlStr).hostname;
  if (/\.(local|internal|localhost)$/i.test(host) || host.toLowerCase() === 'localhost') {
    throw badRequest(`Refusing to fetch an internal address: ${host}`);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw badRequest(`Refusing to fetch a private address: ${host}`);
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw badRequest(`Could not resolve ${host}. Check the website address.`);
  }
  if (addrs.some(a => isPrivateIp(a.address))) {
    throw badRequest(`${host} resolves to a private address; refusing to fetch it.`);
  }
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// --- fetching -------------------------------------------------------------

// fetch() follows redirects on its own, which would skip the per-hop host
// check, so redirects are followed by hand.
async function safeFetch(urlStr) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    return { res, url: current };
  }
  throw badRequest('Too many redirects fetching that website.');
}

async function fetchText(urlStr) {
  const { res, url } = await safeFetch(urlStr);
  if (!res.ok) {
    if (res.status === 403 || res.status === 401 || res.status === 429) {
      throw badRequest(
        `${new URL(url).hostname} blocked the fetch (HTTP ${res.status}). ` +
        'Some sites refuse automated requests -- write the company profile by hand instead.'
      );
    }
    throw badRequest(`Website returned ${res.status} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.subarray(0, MAX_HTML_BYTES).toString('utf8');
}

// robots.txt, read conservatively: we only look for a global disallow of the
// path we want. A missing or unparseable robots.txt is treated as allowed,
// which is the standard reading.
async function robotsAllows(urlStr) {
  const base = new URL(urlStr);
  let txt;
  try {
    txt = await fetchText(`${base.origin}/robots.txt`);
  } catch {
    return true;
  }
  if (/<html/i.test(txt)) return true;            // soft-404 HTML page
  const lines = txt.split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim());
  let inStar = false;
  const disallowed = [];
  for (const line of lines) {
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) { inStar = ua[1].trim() === '*'; continue; }
    const dis = line.match(/^disallow:\s*(.*)$/i);
    if (dis && inStar && dis[1].trim()) disallowed.push(dis[1].trim());
  }
  const path = base.pathname || '/';
  return !disallowed.some(rule => rule === '/' || path.startsWith(rule));
}

// --- HTML -> text ---------------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', hellip: '…', trade: '™',
  reg: '®', copy: '©'
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// Good enough for reading marketing copy: drop the non-content elements, keep
// the meta description (often the cleanest one-line summary on the page), then
// flatten what's left.
function htmlToText(html) {
  const metaDesc = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
  );
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|nav|footer|form|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|section|article|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const text = decodeEntities(body)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map(l => l.trim()).join('\n')
    .trim();

  return [
    title && `Page title: ${decodeEntities(title[1]).trim()}`,
    metaDesc && `Meta description: ${decodeEntities(metaDesc[1]).trim()}`,
    text
  ].filter(Boolean).join('\n\n');
}

// First same-origin link that looks like an About page. One extra fetch at
// most -- we are not crawling the site.
function findAboutUrl(html, baseUrl) {
  const base = new URL(baseUrl);
  const re = /<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    let abs;
    try { abs = new URL(m[1], base); } catch { continue; }
    if (abs.hostname !== base.hostname) continue;
    if (abs.pathname === base.pathname) continue;
    if (/^\/(about|about-us|company|who-we-are)\/?$/i.test(abs.pathname)) {
      abs.hash = '';
      return abs.toString();
    }
  }
  return null;
}

// Reads the homepage and, if it links to one, an About page. Returns the
// combined text plus the pages actually read.
async function readSite(websiteUrl) {
  if (!(await robotsAllows(websiteUrl))) {
    throw badRequest("That site's robots.txt disallows automated fetching.");
  }
  const homeHtml = await fetchText(websiteUrl);
  const pages = [{ url: websiteUrl, text: htmlToText(homeHtml) }];

  const aboutUrl = findAboutUrl(homeHtml, websiteUrl);
  if (aboutUrl) {
    try {
      if (await robotsAllows(aboutUrl)) {
        pages.push({ url: aboutUrl, text: htmlToText(await fetchText(aboutUrl)) });
      }
    } catch {
      // An About page that won't load is not a failure -- the homepage is
      // usually enough on its own.
    }
  }

  const combined = pages
    .map(p => `--- ${p.url} ---\n${p.text}`)
    .join('\n\n')
    .slice(0, MAX_TEXT_CHARS);

  return { text: combined, pages: pages.map(p => p.url) };
}

module.exports = {
  normalizeWebsiteUrl,
  readSite,
  htmlToText,
  isPrivateIp,
  MAX_TEXT_CHARS
};
