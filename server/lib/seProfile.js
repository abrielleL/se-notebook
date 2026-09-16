// The notebook owner's identity, as it appears on customer-facing exports.
//
// The Solutions Engineer on a POV is always whoever runs this notebook, so this
// is one app-level setting rather than a per-account or per-POV field. It lives
// server-side (not in localStorage like the Anthropic key) because the docx is
// rendered on the server and needs the name at export time.

const db = require('../db/database');

const KEY = 'se_profile';
const DEFAULTS = { name: 'Abrielle Land', title: '' };

function read() {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY);
  if (!row) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULTS };
  }
}

// Trim and length-cap both fields: these land in a document header, so an
// accidental paste of a whole signature block shouldn't break the cover page.
function validate(input) {
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  return { config: { name: str(input && input.name, 120), title: str(input && input.title, 120) } };
}

function write(config) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(KEY, JSON.stringify(config));
  return config;
}

module.exports = { read, write, validate, DEFAULTS, KEY };
