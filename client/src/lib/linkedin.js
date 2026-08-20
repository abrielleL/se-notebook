// LinkedIn deep links, client side.
//
// The notebook never calls LinkedIn — there is no API that returns another
// member's profile, and scraping breaches their terms. These build links the
// user opens themselves in their own logged-in session.

// A people-search link for someone we don't have a profile URL for yet.
// Narrowing by employer makes the first result right far more often.
export function linkedInSearchUrl(contact = {}) {
  const terms = [contact.name, contact.org_name || contact.title]
    .filter(Boolean).join(' ').trim();
  if (!terms) return null;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(terms)}`;
}

// Short display form: "in/jane-doe" rather than the full URL.
export function linkedInLabel(url) {
  if (!url) return '';
  return String(url)
    .replace(/^https?:\/\/(www\.)?linkedin\.com\//i, '')
    .replace(/\/$/, '') || url;
}

// Mirrors server/lib/linkedin.js so the field can be validated before saving.
export function looksLikeLinkedInUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return true; // empty is allowed — it clears the field
  return /^(https?:\/\/)?(([a-z0-9-]+\.)*linkedin\.com)\//i.test(raw);
}
