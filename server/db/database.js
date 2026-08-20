const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'se-notebook.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// ---------------------------------------------------------------------------
// Migrations
//
// SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so we inspect
// PRAGMA table_info and only add columns that are missing. New tables use
// `CREATE TABLE IF NOT EXISTS`. All foreign keys reference the existing
// TEXT (UUID) primary keys on accounts(id) and notes(id) — the new tables
// keep their own INTEGER AUTOINCREMENT primary keys.
// ---------------------------------------------------------------------------

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function addColumn(table, column, definition) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// --- accounts additions ---
// risk: 'green' | 'yellow' | 'red' | NULL
addColumn('accounts', 'risk', 'TEXT DEFAULT NULL');
// presales_stage: Sugar CRM stage values (separate from existing opportunity_stage)
addColumn('accounts', 'presales_stage', 'TEXT DEFAULT NULL');
// escalation: 'Tech Blocked' | 'Tech Challenged' | 'Not Needed' | NULL
addColumn('accounts', 'escalation', 'TEXT DEFAULT NULL');
addColumn('accounts', 'jira_ticket_url', 'TEXT DEFAULT NULL');
addColumn('accounts', 'close_date', 'DATE DEFAULT NULL');
addColumn('accounts', 'opportunity_value', 'INTEGER DEFAULT NULL');
addColumn('accounts', 'ae_name', 'TEXT DEFAULT NULL');
addColumn('accounts', 'pov_success_plan_url', 'TEXT DEFAULT NULL');
addColumn('accounts', 'color', 'TEXT DEFAULT NULL');
// tags: JSON array of tag labels chosen from the managed tag_catalog.
addColumn('accounts', 'tags', 'TEXT DEFAULT NULL');

// --- contacts additions ---
// meddpicc_role: internal qualification role; never surfaced as "MEDDPICC" in UI.
// Values: 'decision_maker' | 'champion' | 'technical_lead' | 'influencer' | 'procurement' | NULL
// Retained as the role on the *primary* account; per-account roles now live on
// contact_accounts.role, which is what the UI reads and writes.
addColumn('contacts', 'meddpicc_role', 'TEXT DEFAULT NULL');
addColumn('contacts', 'email', 'TEXT DEFAULT NULL');
addColumn('contacts', 'phone', 'TEXT DEFAULT NULL');
addColumn('contacts', 'auto_extracted', 'INTEGER DEFAULT 0');
// name_key: folded dedupe key (see lib/contactNames.js). Backed by a UNIQUE
// index with account_id, created after the migration collapses existing dupes.
addColumn('contacts', 'name_key', 'TEXT');
// org_name: the person's employer. Essential for partners/analysts, whose
// company is *not* the account they're linked to.
addColumn('contacts', 'org_name', 'TEXT DEFAULT NULL');
// contact_type: 'customer' | 'partner' | 'analyst' | 'internal'
addColumn('contacts', 'contact_type', "TEXT DEFAULT 'customer'");
addColumn('contacts', 'updated_at', 'TIMESTAMP');

// --- notes additions ---
addColumn('notes', 'pending_ai_extraction', 'INTEGER DEFAULT 0');
addColumn('notes', 'note_type', 'TEXT DEFAULT NULL');

// --- next_steps additions ---
// Due date powers the inbox/dashboard urgency coloring (overdue/today/future).
addColumn('next_steps', 'due_date', 'DATE DEFAULT NULL');

// --- pov_drafts additions ---
// Persist the preflight selections (products/deployment/os/use_cases/
// integrations + contact/duration) as JSON so the generator can reload them
// and the prerequisites checklist can be derived.
addColumn('pov_drafts', 'selections', 'TEXT DEFAULT NULL');
// Manual calendar timelines: a pov_draft with manually_created=1, empty text.
addColumn('pov_drafts', 'manually_created', 'INTEGER DEFAULT 0');
addColumn('pov_drafts', 'label', 'TEXT DEFAULT NULL');

// --- new tables ---
db.exec(`
  CREATE TABLE IF NOT EXISTS deal_intelligence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    source_note_id TEXT REFERENCES notes(id),
    UNIQUE(account_id, field)
  );

  CREATE TABLE IF NOT EXISTS stage_gate_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    stage TEXT NOT NULL,
    gate_key TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    completed_at TIMESTAMP,
    UNIQUE(account_id, stage, gate_key)
  );

  CREATE TABLE IF NOT EXISTS pov_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    pov_text TEXT NOT NULL,
    section_texts TEXT,
    se_prep_notes TEXT,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    model_used TEXT,
    chunks_used INTEGER,
    sources TEXT,
    status TEXT DEFAULT 'draft',
    win_loss TEXT DEFAULT NULL,
    win_loss_note TEXT DEFAULT NULL,
    deleted_at TIMESTAMP,
    color TEXT DEFAULT NULL,
    start_date DATE DEFAULT NULL,
    end_date DATE DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS pov_revision_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pov_draft_id INTEGER NOT NULL REFERENCES pov_drafts(id),
    section_key TEXT NOT NULL,
    old_text TEXT,
    new_text TEXT,
    reason TEXT,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    change_type TEXT DEFAULT 'manual'
  );

  CREATE TABLE IF NOT EXISTS account_files (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    category TEXT DEFAULT 'other',
    description TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pov_meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pov_id INTEGER NOT NULL REFERENCES pov_drafts(id),
    type TEXT NOT NULL,            -- 'scoping' | 'kickoff' | 'checkin' | 'wrapup'
    meeting_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tag_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#58a6ff',
    is_inactive INTEGER DEFAULT 0,   -- accounts with an inactive tag drop out of dashboard active views
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pov_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    status TEXT DEFAULT 'pending',
    result_pov_id INTEGER REFERENCES pov_drafts(id),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pov_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    value TEXT NOT NULL,
    icon TEXT DEFAULT 'ti-circle',
    chroma_filter TEXT,        -- legacy single slug; kept for back-compat (superseded by chroma_filters)
    chroma_filters TEXT,       -- JSON array of ChromaDB folder slugs
    valid_deployments TEXT,    -- JSON array of deployment values this product supports
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  -- A contact belongs to many accounts (a partner SE works several deals) and
  -- an account has many contacts. The qualification role lives here, not on the
  -- contact: the same person can be a champion on one deal and a blocker on
  -- another. Exactly one link per contact carries is_primary=1, mirrored into
  -- contacts.account_id for the FTS triggers.
  CREATE TABLE IF NOT EXISTS contact_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role TEXT,
    is_primary INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contact_id, account_id)
  );

  -- Free-form notes about a person. account_id is nullable so a note can be
  -- either deal-specific ("pushed our POV internally at Acme") or about the
  -- person generally ("prefers a call over email").
  CREATE TABLE IF NOT EXISTS contact_notes (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP
  );

  -- Possible-duplicate pairs that are too ambiguous to merge automatically
  -- (misspellings, first-name-only fragments). Reviewed in the directory UI.
  -- contact_id_a/_b are stored sorted so UNIQUE prevents re-queueing a pair.
  CREATE TABLE IF NOT EXISTS contact_merge_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT,
    contact_id_a TEXT NOT NULL,
    contact_id_b TEXT NOT NULL,
    reason TEXT,
    score REAL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(contact_id_a, contact_id_b)
  );

  CREATE INDEX IF NOT EXISTS idx_contact_accounts_contact ON contact_accounts(contact_id);
  CREATE INDEX IF NOT EXISTS idx_contact_accounts_account ON contact_accounts(account_id);
  CREATE INDEX IF NOT EXISTS idx_contact_notes_contact ON contact_notes(contact_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_name_key ON contacts(name_key);
  CREATE INDEX IF NOT EXISTS idx_merge_candidates_status ON contact_merge_candidates(status);

  CREATE INDEX IF NOT EXISTS idx_deal_intelligence_account ON deal_intelligence(account_id);
  CREATE INDEX IF NOT EXISTS idx_stage_gate_account ON stage_gate_progress(account_id);
  CREATE INDEX IF NOT EXISTS idx_pov_drafts_account ON pov_drafts(account_id);
  CREATE INDEX IF NOT EXISTS idx_pov_revision_draft ON pov_revision_history(pov_draft_id);
  CREATE INDEX IF NOT EXISTS idx_pov_config_category ON pov_config(category);
  CREATE INDEX IF NOT EXISTS idx_pov_jobs_account ON pov_jobs(account_id);
  CREATE INDEX IF NOT EXISTS idx_account_files_account ON account_files(account_id);
  CREATE INDEX IF NOT EXISTS idx_pov_meetings_pov ON pov_meetings(pov_id);
`);

// ---------------------------------------------------------------------------
// pov_config migration: single chroma_filter -> chroma_filters (JSON array),
// add valid_deployments (JSON array), enforce UNIQUE(category, value).
// The legacy chroma_filter column is intentionally kept for back-compat.
// ---------------------------------------------------------------------------
addColumn('pov_config', 'chroma_filters', 'TEXT');
addColumn('pov_config', 'valid_deployments', 'TEXT');
// Migrate any legacy single-slug values into the JSON-array column once.
db.exec(`
  UPDATE pov_config SET chroma_filters = json_array(chroma_filter)
  WHERE chroma_filter IS NOT NULL AND chroma_filters IS NULL;
`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pov_config_cat_value ON pov_config(category, value);');

// --- seed-once categories (os / use_case / integration) — never re-seed on restart ---
const POV_CONFIG_SEED = [
  // category, label, value, icon, chroma_filter, sort_order
  ['os', 'Windows Server 2022', 'windows-2022', 'ti-brand-windows', null, 0],
  ['os', 'Windows Server 2019', 'windows-2019', 'ti-brand-windows', null, 1],
  ['os', 'RHEL / CentOS', 'rhel', 'ti-brand-ubuntu', null, 2],
  ['os', 'Ubuntu', 'ubuntu', 'ti-brand-ubuntu', null, 3],
  ['os', 'Debian', 'debian', 'ti-brand-debian', null, 4],

  ['use_case', 'File upload scanning', 'file-upload', 'ti-file-check', null, 0],
  ['use_case', 'Removable media control', 'removable-media', 'ti-usb', null, 1],
  ['use_case', 'Deep CDR / sanitization', 'deep-cdr', 'ti-refresh', null, 2],
  ['use_case', 'Secure file transfer (OT)', 'secure-transfer', 'ti-arrow-right', null, 3],
  ['use_case', 'Storage scanning (NAS/S3)', 'storage-scan', 'ti-server-2', null, 4],
  ['use_case', 'Email attachment scanning', 'email-scan', 'ti-mail-opened', null, 5],
  ['use_case', 'Zero-day prevention', 'zero-day', 'ti-shield-check', null, 6],
  ['use_case', 'Endpoint compliance', 'endpoint', 'ti-device-laptop', null, 7],
  ['use_case', 'OT/ICS visibility', 'ot-visibility', 'ti-antenna', null, 8],
  ['use_case', 'ICAP integration', 'icap', 'ti-link', null, 9],
  ['use_case', 'Software supply chain', 'supply-chain', 'ti-package', null, 10],

  ['integration', 'Active Directory', 'ad', 'ti-brand-windows', null, 0],
  ['integration', 'Web proxy / WAF', 'proxy', 'ti-network', null, 1],
  ['integration', 'SharePoint', 'sharepoint', 'ti-database', null, 2],
  ['integration', 'S3 / Azure Blob', 's3', 'ti-cloud', null, 3],
  ['integration', 'Exchange / O365', 'exchange', 'ti-mail', null, 4],
  ['integration', 'SCADA / DCS', 'scada', 'ti-cpu', null, 5],
  ['integration', 'SIEM', 'siem', 'ti-shield', null, 6],
  ['integration', 'ICAP-enabled proxy', 'icap-proxy', 'ti-arrows-exchange', null, 7]
];

const povConfigCount = db.prepare('SELECT COUNT(*) AS n FROM pov_config').get().n;
if (povConfigCount === 0) {
  const insertPovConfig = db.prepare(`
    INSERT INTO pov_config (category, label, value, icon, chroma_filter, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const seedPovConfig = db.transaction((rows) => {
    for (const row of rows) insertPovConfig.run(...row);
  });
  seedPovConfig(POV_CONFIG_SEED);
}

// ---------------------------------------------------------------------------
// Managed catalog (deployment / product / technology / file_type / compliance).
// Re-seeded on every startup via INSERT OR REPLACE so the canonical list stays
// current. Rows are [category, label, value, icon, chroma_filters[], valid_deployments[]].
// chroma_filters/valid_deployments are JS arrays here; null where not applicable.
// ---------------------------------------------------------------------------
const POV_DEPLOYMENTS = [
  ['On-prem Windows', 'onprem-windows', 'ti-brand-windows'],
  ['On-prem Linux', 'onprem-linux', 'ti-brand-ubuntu'],
  ['On-prem Mac', 'onprem-mac', 'ti-brand-apple'],
  ['Containerized', 'container', 'ti-brand-docker'],
  ['AWS', 'aws', 'ti-brand-aws'],
  ['GCP', 'gcp', 'ti-brand-gcp'],
  ['Azure', 'azure', 'ti-brand-azure'],
  ['SaaS (OPSWAT-hosted)', 'saas', 'ti-cloud'],
  ['OPSWAT hardware', 'hardware', 'ti-server'],
  ['Virtual appliance', 'virtual', 'ti-box'],
  ['On-prem VM', 'onprem-vm', 'ti-device-desktop'],
  ['Hybrid', 'hybrid', 'ti-network'],
  ['Air-gapped', 'airgap', 'ti-lock']
].map(([label, value, icon], i) => ['deployment', label, value, icon, null, null, i]);

const POV_PRODUCTS = [
  // [label, value, icon, chroma_filters[], valid_deployments[]]
  ['MetaDefender Core', 'mdcore', 'ti-shield-check', ['mdcore'], ['onprem-windows', 'onprem-linux', 'container', 'aws', 'gcp', 'azure']],
  ['MetaDefender ICAP Server', 'mdicap', 'ti-arrows-exchange', ['mdicap'], ['onprem-windows', 'onprem-linux', 'container', 'aws', 'gcp']],
  ['MetaDefender ICAP Cloud', 'mdicap-cloud', 'ti-cloud-upload', ['mdicap'], ['saas']],
  ['MetaDefender Storage Security', 'mdss', 'ti-database', ['mdss'], ['onprem-windows', 'onprem-linux', 'container', 'aws', 'gcp']],
  ['MetaDefender Storage Security Cloud', 'mdss-cloud', 'ti-cloud', ['mdss'], ['saas']],
  ['MetaDefender for Salesforce', 'mdfs', 'ti-brand-salesforce', ['mdfs'], ['saas']],
  ['MetaDefender Email Gateway Security', 'mdemail', 'ti-mail', ['mdemail'], ['onprem-windows', 'onprem-linux', 'container', 'aws', 'gcp']],
  ['MetaDefender Cloud Email Security', 'mdemail-cloud', 'ti-mail-opened', ['mdemail'], ['saas']],
  ['MetaDefender MFT', 'mdmft', 'ti-switch-horizontal', ['mdmft'], ['onprem-windows', 'onprem-linux', 'container', 'aws', 'gcp']],
  ['MetaDefender Kiosk', 'mdkiosk', 'ti-device-usb', ['mdkiosk', 'mdkiosk-linux'], ['onprem-windows', 'onprem-linux', 'container', 'aws', 'gcp', 'hardware']],
  ['MetaDefender Media Firewall', 'mdmediafirewall', 'ti-firewall', ['mdmediafirewall'], ['hardware']],
  ['MetaDefender Endpoint', 'mdendpoint', 'ti-device-laptop', ['mdendpoint', 'cm', 'my', 'myop', 'ocm'], ['onprem-windows', 'onprem-linux', 'onprem-mac']],
  ['MetaDefender Drive', 'mddrive', 'ti-usb', ['mddrive'], ['hardware']],
  ['MetaDefender Drive Smart Touch', 'mddrive-smart', 'ti-hand-finger', ['mddrive'], ['hardware']],
  ['MetaDefender Aether (on-prem)', 'mdaether', 'ti-bug', ['filescan'], ['onprem-linux']],
  ['MetaDefender Aether for Cloud', 'mdaether-cloud', 'ti-cloud-storm', ['filescan'], ['saas']],
  ['MetaDefender Threat Intelligence', 'mdti', 'ti-radar', ['mdinsights'], ['saas', 'onprem-linux']],
  ['MetaDefender InSights C2', 'mdinsights-c2', 'ti-antenna', ['mdinsights'], ['saas']],
  ['MetaDefender InSights TI', 'mdinsights-ti', 'ti-shield-bolt', ['mdinsights'], ['saas']],
  ['MetaDefender InSights OSINT', 'mdinsights-osint', 'ti-world-search', ['mdinsights'], ['saas']],
  ['Filescan.io', 'filescan', 'ti-file-search', ['filescan'], ['saas']],
  ['MetaDefender NDR', 'mdndr', 'ti-network', ['mdndr'], ['virtual', 'hardware']],
  ['MetaDefender NAC', 'mdnac', 'ti-lock-access', ['manac'], ['saas', 'onprem-vm', 'hybrid']],
  ['MetaDefender OT Security', 'mdot', 'ti-cpu', ['md-ot-security'], ['hardware', 'virtual']],
  ['MetaDefender OT Access', 'mdot-access', 'ti-key', ['metadefender-ot-access'], ['hardware', 'virtual']],
  ['MetaDefender Industrial Firewall', 'mdif', 'ti-firewall', ['mdif4p'], ['hardware']],
  ['MetaDefender Netwall', 'mdnetwall', 'ti-arrow-right-square', ['netwall'], ['hardware']],
  ['MetaDefender Optical Diode', 'mdoptical', 'ti-square-arrow-right', ['netwalldiode'], ['hardware']],
  ['MetaDefender USG', 'mdusg', 'ti-chevrons-right', ['netwall'], ['hardware']],
  ['MetaDefender BSG', 'mdbsg', 'ti-arrows-right-left', ['netwall'], ['hardware']],
  ['MetaDefender Diode X', 'mddiodex', 'ti-arrow-bar-right', ['mdtransferguard'], ['hardware']],
  ['Fend Optical Diode', 'fenddiode', 'ti-arrow-narrow-right', ['fenddiode'], ['hardware']],
  ['MetaDefender Cloud', 'mdcloud', 'ti-cloud', ['macloud-sdp'], ['saas']],
  ['My OPSWAT Central Management', 'myop', 'ti-dashboard', ['myop', 'ocm', 'cm'], ['saas', 'onprem-windows', 'onprem-linux', 'virtual']],
  ['MetaDefender Software Supply Chain', 'mdsupplychain', 'ti-package', ['supply-chain'], ['onprem-linux', 'container']],
  ['MetaDefender Distributed Cluster', 'mdcluster', 'ti-topology-star', ['mdcluster'], ['onprem-windows', 'onprem-linux', 'container', 'aws', 'gcp', 'azure']],
  ['OESIS Framework', 'oesis', 'ti-code', null, ['onprem-windows', 'onprem-linux', 'saas']],
  ['MetaDefender Endpoint Security SDK', 'mdsdk', 'ti-brackets', ['mdsdk'], ['onprem-windows', 'onprem-linux']]
].map(([label, value, icon, cf, vd], i) => ['product', label, value, icon, cf, vd, i]);

const POV_TECHNOLOGIES = [
  // Metascan Windows engine tiers (single-select tier in the form)
  ['Metascan Windows — 8 engines', 'metascan-win-8', 'ti-scan'],
  ['Metascan Windows — 12 engines', 'metascan-win-12', 'ti-scan'],
  ['Metascan Windows — 16 engines', 'metascan-win-16', 'ti-scan'],
  ['Metascan Windows — 20 engines', 'metascan-win-20', 'ti-scan'],
  ['Metascan Windows — Max engines', 'metascan-win-max', 'ti-scan'],
  // Metascan Linux engine tiers (single-select tier in the form)
  ['Metascan Linux — 5 engines', 'metascan-lin-5', 'ti-scan'],
  ['Metascan Linux — 10 engines', 'metascan-lin-10', 'ti-scan'],
  ['Metascan Linux — Max engines', 'metascan-lin-max', 'ti-scan'],
  // Multi-select technologies
  ['Deep CDR', 'deep-cdr', 'ti-scissors'],
  ['Proactive DLP', 'proactive-dlp', 'ti-shield-lock'],
  ['Adaptive Sandbox / Aether', 'adaptive-sandbox', 'ti-bug'],
  ['Threat Intelligence', 'tech-ti', 'ti-radar'],
  ['File-based Vulnerability Assessment', 'file-vuln', 'ti-file-alert'],
  ['SBOM', 'sbom', 'ti-list-details'],
  ['Country of Origin (COO)', 'coo', 'ti-world'],
  ['Predictive Alin AI', 'predictive-ai', 'ti-brain']
].map(([label, value, icon], i) => ['technology', label, value, icon, ['mdcore'], null, i]);

// NOTE: file_type and compliance option lists were not enumerated in the spec.
// These are sensible defaults (NERC CIP is referenced in the spec's verification
// steps) — edit them in Settings > POV Config, or tell me the canonical lists.
const POV_FILE_TYPES = [
  ['Office documents (Word/Excel/PowerPoint)', 'office', 'ti-file-text'],
  ['PDF', 'pdf', 'ti-file-type-pdf'],
  ['Archives (ZIP/RAR/7z)', 'archive', 'ti-file-zip'],
  ['Images', 'image', 'ti-photo'],
  ['Executables / binaries', 'executable', 'ti-binary'],
  ['Email files (EML/MSG)', 'email-file', 'ti-mail'],
  ['Source code', 'source-code', 'ti-code'],
  ['Media (audio/video)', 'media', 'ti-movie'],
  ['CAD / engineering files', 'cad', 'ti-ruler-2'],
  ['Firmware / OT files', 'firmware', 'ti-cpu']
].map(([label, value, icon], i) => ['file_type', label, value, icon, null, null, i]);

const POV_COMPLIANCE = [
  ['NERC CIP', 'nerc-cip', 'ti-bolt'],
  ['NIST 800-53', 'nist-800-53', 'ti-certificate'],
  ['NIST 800-171', 'nist-800-171', 'ti-certificate'],
  ['IEC 62443', 'iec-62443', 'ti-cpu'],
  ['ISO 27001', 'iso-27001', 'ti-certificate'],
  ['HIPAA', 'hipaa', 'ti-heartbeat'],
  ['PCI-DSS', 'pci-dss', 'ti-credit-card'],
  ['CMMC', 'cmmc', 'ti-shield-check'],
  ['FedRAMP', 'fedramp', 'ti-building-bank'],
  ['GDPR', 'gdpr', 'ti-gavel']
].map(([label, value, icon], i) => ['compliance', label, value, icon, null, null, i]);

// Remove rows for managed slugs that were renamed in this catalog revision so
// they don't linger as orphans (INSERT OR REPLACE only upserts matching values).
db.exec(`
  DELETE FROM pov_config WHERE category = 'deployment' AND value IN ('on-prem', 'cloud', 'air-gapped');
  DELETE FROM pov_config WHERE category = 'product' AND value IN ('manac', 'md-ot-security', 'netwall');
`);

const upsertManaged = db.prepare(`
  INSERT OR REPLACE INTO pov_config (category, label, value, icon, chroma_filters, valid_deployments, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const seedManaged = db.transaction((rows) => {
  for (const [category, label, value, icon, cf, vd, sort] of rows) {
    upsertManaged.run(category, label, value, icon, cf ? JSON.stringify(cf) : null, vd ? JSON.stringify(vd) : null, sort);
  }
});
seedManaged([...POV_DEPLOYMENTS, ...POV_PRODUCTS, ...POV_TECHNOLOGIES, ...POV_FILE_TYPES, ...POV_COMPLIANCE]);

// ---------------------------------------------------------------------------
// Contacts: normalize names, backfill account links, collapse duplicates.
//
// Must run before the UNIQUE(account_id, name_key) index below -- existing
// databases contain duplicate keys ("Erika Pinczesi" vs "Erika Pinczesi -")
// that would make the index creation fail. Also runs before the search-index
// rebuild so merged-away contacts don't linger as search results.
// ---------------------------------------------------------------------------
require('./contactsMigration').migrateContacts(db);

// Prevents a repeat of the original bug at the storage layer: two concurrent
// extractions can no longer both insert the same person. Scoped to the primary
// account, since the same name on two different accounts is two people.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_name_key
    ON contacts(account_id, name_key)
    WHERE account_id IS NOT NULL AND name_key IS NOT NULL;
`);

// ---------------------------------------------------------------------------
// Global search: extend the FTS index beyond notes/transcripts.
//
// schema.sql already maintains 'note' and 'transcript' rows via triggers. Here
// we add triggers for the remaining account-scoped content so a term anywhere
// — account name/AE/industry, AI summary, a contact's name, a deal field, a
// file name — resolves back to its account. These tables either gain columns
// via migrations above (accounts, contacts) or are created in this file
// (deal_intelligence, account_files), so their triggers must live here, after
// the columns/tables exist, rather than in schema.sql.
//
// `body` repeats the title text so a title-only match still produces a snippet.
// ---------------------------------------------------------------------------
db.exec(`
  -- accounts -> 'account'
  CREATE TRIGGER IF NOT EXISTS accounts_search_ai AFTER INSERT ON accounts BEGIN
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    VALUES ('account', NEW.id, NEW.id, COALESCE(NEW.account_name, ''),
      COALESCE(NEW.account_name,'')||' '||COALESCE(NEW.account_executive,'')||' '||COALESCE(NEW.ae_name,'')||' '||
      COALESCE(NEW.industry,'')||' '||COALESCE(NEW.opportunity_stage,'')||' '||COALESCE(NEW.presales_stage,'')||' '||
      COALESCE(NEW.ai_summary,'')||' '||COALESCE(NEW.ai_technical_drivers,'')||' '||COALESCE(NEW.ai_environment,'')||' '||
      COALESCE(NEW.tags,''));
  END;
  CREATE TRIGGER IF NOT EXISTS accounts_search_au AFTER UPDATE ON accounts BEGIN
    DELETE FROM search_index WHERE source_type = 'account' AND source_id = OLD.id;
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    VALUES ('account', NEW.id, NEW.id, COALESCE(NEW.account_name, ''),
      COALESCE(NEW.account_name,'')||' '||COALESCE(NEW.account_executive,'')||' '||COALESCE(NEW.ae_name,'')||' '||
      COALESCE(NEW.industry,'')||' '||COALESCE(NEW.opportunity_stage,'')||' '||COALESCE(NEW.presales_stage,'')||' '||
      COALESCE(NEW.ai_summary,'')||' '||COALESCE(NEW.ai_technical_drivers,'')||' '||COALESCE(NEW.ai_environment,'')||' '||
      COALESCE(NEW.tags,''));
  END;
  CREATE TRIGGER IF NOT EXISTS accounts_search_ad AFTER DELETE ON accounts BEGIN
    DELETE FROM search_index WHERE source_type = 'account' AND source_id = OLD.id;
  END;

  -- contacts -> 'contact'
  -- Dropped and recreated (rather than CREATE IF NOT EXISTS) because the body
  -- now also indexes org_name/contact_type, which older databases won't have
  -- picked up from a pre-existing trigger definition.
  DROP TRIGGER IF EXISTS contacts_search_ai;
  DROP TRIGGER IF EXISTS contacts_search_au;
  DROP TRIGGER IF EXISTS contacts_search_ad;
  CREATE TRIGGER contacts_search_ai AFTER INSERT ON contacts BEGIN
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    VALUES ('contact', NEW.id, NEW.account_id, COALESCE(NEW.name, ''),
      COALESCE(NEW.name,'')||' '||COALESCE(NEW.title,'')||' '||COALESCE(NEW.email,'')||' '||
      COALESCE(NEW.phone,'')||' '||COALESCE(NEW.org_name,'')||' '||COALESCE(NEW.contact_type,''));
  END;
  CREATE TRIGGER contacts_search_au AFTER UPDATE ON contacts BEGIN
    DELETE FROM search_index WHERE source_type = 'contact' AND source_id = OLD.id;
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    VALUES ('contact', NEW.id, NEW.account_id, COALESCE(NEW.name, ''),
      COALESCE(NEW.name,'')||' '||COALESCE(NEW.title,'')||' '||COALESCE(NEW.email,'')||' '||
      COALESCE(NEW.phone,'')||' '||COALESCE(NEW.org_name,'')||' '||COALESCE(NEW.contact_type,''));
  END;
  CREATE TRIGGER contacts_search_ad AFTER DELETE ON contacts BEGIN
    DELETE FROM search_index WHERE source_type = 'contact' AND source_id = OLD.id;
  END;

  -- contact_notes -> 'contact_note'. Titled with the person's name so a search
  -- hit reads as "Ron Howell" rather than an opaque note id.
  CREATE TRIGGER IF NOT EXISTS contact_notes_search_ai AFTER INSERT ON contact_notes BEGIN
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    SELECT 'contact_note', NEW.id, COALESCE(NEW.account_id, c.account_id),
      COALESCE(c.name, ''), COALESCE(c.name,'')||' '||COALESCE(NEW.body,'')
    FROM contacts c WHERE c.id = NEW.contact_id;
  END;
  CREATE TRIGGER IF NOT EXISTS contact_notes_search_au AFTER UPDATE ON contact_notes BEGIN
    DELETE FROM search_index WHERE source_type = 'contact_note' AND source_id = OLD.id;
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    SELECT 'contact_note', NEW.id, COALESCE(NEW.account_id, c.account_id),
      COALESCE(c.name, ''), COALESCE(c.name,'')||' '||COALESCE(NEW.body,'')
    FROM contacts c WHERE c.id = NEW.contact_id;
  END;
  CREATE TRIGGER IF NOT EXISTS contact_notes_search_ad AFTER DELETE ON contact_notes BEGIN
    DELETE FROM search_index WHERE source_type = 'contact_note' AND source_id = OLD.id;
  END;

  -- deal_intelligence -> 'deal'
  CREATE TRIGGER IF NOT EXISTS deal_intel_search_ai AFTER INSERT ON deal_intelligence BEGIN
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    VALUES ('deal', NEW.id, NEW.account_id, COALESCE(NEW.field, ''),
      COALESCE(NEW.field,'')||' '||COALESCE(NEW.value,''));
  END;
  CREATE TRIGGER IF NOT EXISTS deal_intel_search_au AFTER UPDATE ON deal_intelligence BEGIN
    DELETE FROM search_index WHERE source_type = 'deal' AND source_id = OLD.id;
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    VALUES ('deal', NEW.id, NEW.account_id, COALESCE(NEW.field, ''),
      COALESCE(NEW.field,'')||' '||COALESCE(NEW.value,''));
  END;
  CREATE TRIGGER IF NOT EXISTS deal_intel_search_ad AFTER DELETE ON deal_intelligence BEGIN
    DELETE FROM search_index WHERE source_type = 'deal' AND source_id = OLD.id;
  END;

  -- account_files -> 'file' (soft-deleted: only index rows with deleted_at IS NULL)
  CREATE TRIGGER IF NOT EXISTS account_files_search_ai AFTER INSERT ON account_files BEGIN
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    SELECT 'file', NEW.id, NEW.account_id, COALESCE(NEW.original_name, ''),
      COALESCE(NEW.original_name,'')||' '||COALESCE(NEW.description,'')||' '||COALESCE(NEW.category,'')
    WHERE NEW.deleted_at IS NULL;
  END;
  CREATE TRIGGER IF NOT EXISTS account_files_search_au AFTER UPDATE ON account_files BEGIN
    DELETE FROM search_index WHERE source_type = 'file' AND source_id = OLD.id;
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    SELECT 'file', NEW.id, NEW.account_id, COALESCE(NEW.original_name, ''),
      COALESCE(NEW.original_name,'')||' '||COALESCE(NEW.description,'')||' '||COALESCE(NEW.category,'')
    WHERE NEW.deleted_at IS NULL;
  END;
  CREATE TRIGGER IF NOT EXISTS account_files_search_ad AFTER DELETE ON account_files BEGIN
    DELETE FROM search_index WHERE source_type = 'file' AND source_id = OLD.id;
  END;

  -- attachments -> 'attachment' (hard delete; original_name is the human name)
  CREATE TRIGGER IF NOT EXISTS attachments_search_ai AFTER INSERT ON attachments BEGIN
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    VALUES ('attachment', NEW.id, NEW.account_id, COALESCE(NEW.original_name, ''), COALESCE(NEW.original_name, ''));
  END;
  CREATE TRIGGER IF NOT EXISTS attachments_search_au AFTER UPDATE ON attachments BEGIN
    DELETE FROM search_index WHERE source_type = 'attachment' AND source_id = OLD.id;
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    VALUES ('attachment', NEW.id, NEW.account_id, COALESCE(NEW.original_name, ''), COALESCE(NEW.original_name, ''));
  END;
  CREATE TRIGGER IF NOT EXISTS attachments_search_ad AFTER DELETE ON attachments BEGIN
    DELETE FROM search_index WHERE source_type = 'attachment' AND source_id = OLD.id;
  END;
`);

// Backfill the newly-indexed source types from existing rows. Triggers only
// fire on future writes, so without this, accounts/contacts/etc. created before
// this code shipped would be invisible to search. Rebuilding these five types
// on every startup is cheap at this scale and self-heals any drift; the
// trigger-maintained 'note'/'transcript' rows are left untouched.
const rebuildSearchIndex = db.transaction(() => {
  db.exec("DELETE FROM search_index WHERE source_type IN ('account','contact','contact_note','deal','file','attachment')");
  db.exec(`
    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    SELECT 'account', id, id, COALESCE(account_name,''),
      COALESCE(account_name,'')||' '||COALESCE(account_executive,'')||' '||COALESCE(ae_name,'')||' '||
      COALESCE(industry,'')||' '||COALESCE(opportunity_stage,'')||' '||COALESCE(presales_stage,'')||' '||
      COALESCE(ai_summary,'')||' '||COALESCE(ai_technical_drivers,'')||' '||COALESCE(ai_environment,'')||' '||
      COALESCE(tags,'')
    FROM accounts;

    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    SELECT 'contact', id, account_id, COALESCE(name,''),
      COALESCE(name,'')||' '||COALESCE(title,'')||' '||COALESCE(email,'')||' '||
      COALESCE(phone,'')||' '||COALESCE(org_name,'')||' '||COALESCE(contact_type,'')
    FROM contacts;

    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    SELECT 'contact_note', cn.id, COALESCE(cn.account_id, c.account_id), COALESCE(c.name,''),
      COALESCE(c.name,'')||' '||COALESCE(cn.body,'')
    FROM contact_notes cn JOIN contacts c ON c.id = cn.contact_id;

    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    SELECT 'deal', id, account_id, COALESCE(field,''), COALESCE(field,'')||' '||COALESCE(value,'')
    FROM deal_intelligence;

    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    SELECT 'file', id, account_id, COALESCE(original_name,''),
      COALESCE(original_name,'')||' '||COALESCE(description,'')||' '||COALESCE(category,'')
    FROM account_files WHERE deleted_at IS NULL;

    INSERT INTO search_index(source_type, source_id, account_id, title, body)
    SELECT 'attachment', id, account_id, COALESCE(original_name,''), COALESCE(original_name,'')
    FROM attachments;
  `);
});
rebuildSearchIndex();

module.exports = db;
