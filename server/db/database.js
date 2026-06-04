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

// --- contacts additions ---
// meddpicc_role: internal qualification role; never surfaced as "MEDDPICC" in UI.
// Values: 'decision_maker' | 'champion' | 'technical_lead' | 'influencer' | 'procurement' | NULL
addColumn('contacts', 'meddpicc_role', 'TEXT DEFAULT NULL');
addColumn('contacts', 'email', 'TEXT DEFAULT NULL');
addColumn('contacts', 'phone', 'TEXT DEFAULT NULL');
addColumn('contacts', 'auto_extracted', 'INTEGER DEFAULT 0');

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

  CREATE INDEX IF NOT EXISTS idx_deal_intelligence_account ON deal_intelligence(account_id);
  CREATE INDEX IF NOT EXISTS idx_stage_gate_account ON stage_gate_progress(account_id);
  CREATE INDEX IF NOT EXISTS idx_pov_drafts_account ON pov_drafts(account_id);
  CREATE INDEX IF NOT EXISTS idx_pov_revision_draft ON pov_revision_history(pov_draft_id);
  CREATE INDEX IF NOT EXISTS idx_pov_config_category ON pov_config(category);
  CREATE INDEX IF NOT EXISTS idx_pov_jobs_account ON pov_jobs(account_id);
  CREATE INDEX IF NOT EXISTS idx_account_files_account ON account_files(account_id);
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

module.exports = db;
