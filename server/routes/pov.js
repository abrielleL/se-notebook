const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const { callAnthropic, getKey, DEFAULT_MODEL } = require('../lib/anthropic');
const { queryDocs } = require('../lib/chroma');
const { getEmbedding } = require('../lib/embed');
const { contactsForAccount } = require('../lib/contactStore');

const EMBED_FAIL_BANNER = '⚠ This POV was generated without OPSWAT documentation sources. To get deployment-specific instructions and accurate prerequisites, start the embed server on your Mac and regenerate: node embed-server.js (in se-notebook folder)';

const router = express.Router();

const POV_MODEL = 'claude-sonnet-4-6';
const LOW_CONFIDENCE_DISTANCE = 0.7;

// Identity colors for account cards / POV timeline bars, cycled on creation.
//
// Brand hues (product-UI chart-1..6), re-stepped for the dark app surfaces:
// the kit's light-mode chart values fail four of the six dataviz checks against
// #081938. Verified with the dataviz validator on that surface — worst adjacent
// CVD deltaE 18.8, normal-vision floor 32.3, every slot >= 3:1 contrast.
// Status colors are deliberately NOT in this list: red/amber/green mean risk
// elsewhere in the app and must not double as decoration.
const POV_COLORS = ['#008a00', '#1d6bfc', '#e06106', '#8f47e8', '#e51a16', '#0f8fa3'];

const SYSTEM_PROMPT = `You are an expert OPSWAT Solutions Engineer with deep hands-on knowledge of the MetaDefender product family, deployment architectures, and critical infrastructure security use cases. You are writing a Proof of Value (PoV) Plan & Success Criteria document for a prospective customer.

OPSWAT core differentiators to use where relevant:
- MetaDefender technology: multi-scanning with 30+ AV engines for known threats; Deep CDR (Content Disarm and Reconstruction) neutralizes zero-day file-based threats by sanitizing and reconstructing 180+ file types; Proactive DLP for sensitive data detection
- Network segmentation and cross-domain solutions including data diodes (Netwall, Optical Diode, USG, BSG) for air-gapped and OT/ICS environments
- 98% of US nuclear power facilities trust OPSWAT -- lead with this for critical infrastructure customers
- Flexible deployment: on-prem, cloud, air-gapped, hybrid, containerized (Docker/Kubernetes)
- ICAP integration enables inline scanning with existing proxies, WAFs, and storage without code changes

Deployment and configuration guidance rules:
- Pull specific installation steps from the documentation excerpts provided
- Include specific system requirements (OS, CPU, RAM, ports) from the docs
- After each installation step or configuration detail, cite the source as: (ref: https://docs.opswat.com/...)
- Flag any section where documentation was insufficient: [Note: verify this section against current documentation]
- For air-gapped deployments: always include offline license staging and offline signature update package instructions with lead time warnings

Product-accuracy rules (CRITICAL — accuracy outranks completeness):
- Only attribute a capability to a product if that product actually provides it. Do NOT assume every product includes multi-scanning, Deep CDR, or Proactive DLP.
- MetaDefender Drive performs multi-scanning-based inspection of laptops, USB drives, and removable media; it does NOT perform Deep CDR (Content Disarm and Reconstruction). Never describe CDR as part of MetaDefender Drive.
- If the provided documentation does not support a specific capability, prerequisite, version, port, or step, do not state it — say the item should be verified against current documentation rather than guessing.
- Do NOT fabricate specific quantitative targets (number of devices scanned, number of files, detection percentages such as "100%"). Keep claims qualitative unless the SE explicitly provided numbers.

Tone: professional, consultative, direct. Write as an SE who has deployed these products many times, not a marketer.`;

const SECTION_SPEC = `Generate the complete PoV document with these exact sections. Fill all placeholders with specific content. Do not leave any section generic or template-like.

SECTION 1: Purpose
Brief paragraph specific to this customer's environment and drivers.

SECTION 2: Products in scope
Table: Product/Module | Version | Customer-specific purpose
List only relevant products. Version = 'Latest' if unknown. Purpose must be customer-specific.

SECTION 3: Customer environment
Table: Item | Detail
Fill from selected_deployment and selected_os: Deployment location | Operating system(s) | Internet connectivity | Authentication | Other relevant context

SECTION 4: Objectives & success criteria
Table: # | Success criterion | Validation method | Result
Write 4-6 clear, verifiable criteria. Each must: be specific to this customer's environment, have a concrete validation method described qualitatively (e.g. 'Submit known-malicious and benign test files and confirm the threat verdict and report are correct'), be achievable in a 2-week POV, and map to a capability the selected product actually provides. Do NOT invent specific quantities or percentages (number of devices, number of files, '100% detection') unless the SE provided them. Result column: [ ] Met [ ] Not Met. If success criteria override provided: use verbatim.

SECTION 5: Scope
5.1 In scope: bullet list
5.2 Out of scope: bullet list (include production traffic, HA/clustering, full deployment sizing)

SECTION 6: Use cases
Table: ID | Use case | Customer-specific description | Product(s)
3-5 use cases matching selected_use_cases. Descriptions must reference their actual environment.

SECTION 7: Plan & timeline
Table: When | Activity | Description | Date
Standard 2-week: Pre-kickoff | Week 1 Deploy & Configure | Mid-POV check-in | Week 2 Execute Tests | Close-out. For Week 1 Deploy & Configure: include numbered installation steps from documentation with source URLs.

SECTION 8: Technical prerequisites
8.1 Per-product requirements table for each selected product. Pull from documentation: supported OS, CPU/RAM/disk sizing, required ports, software dependencies, external URLs. If air-gapped selected: include offline license file note with 5 business day lead time warning.
8.2 Pre-kickoff checklist: standard items plus environment-specific items based on deployment type.

SECTION 9: Roles & contacts
Table with contacts from account data.

SECTION 10: Assumptions & risks
Table: # | Assumption or Risk | Mitigation
3-5 items specific to this customer. If known risks provided: include verbatim. If air-gapped: include offline license deadline risk. If OT environment: include change control timeline risk.

SECTION 11: Sign-off & next steps
Standard sign-off table. Include 'Recommended next steps' paragraph suggesting follow-on engagement based on POV scope.

OUTPUT FORMAT: Return as structured text using plain 'SECTION N: [name]' section headers, exactly — no leading '#' marks, and no document title, subtitle, byline, or horizontal rules ('---') before SECTION 1. Within a section, use a Markdown pipe table only where a table is specified above, and '- ' bullets only where a bullet list is specified. Do NOT use bold ('**'), italic ('*'), or heading ('#') decoration anywhere in the prose. Write clean plain sentences. This will be parsed by section for storage and display.`;

// --- helpers ---

function loadPovConfigMaps() {
  const rows = db.prepare('SELECT category, value, label, chroma_filter, chroma_filters FROM pov_config WHERE active = 1').all();
  const byValue = {};
  for (const r of rows) byValue[`${r.category}:${r.value}`] = r;
  return byValue;
}

function labelsFor(category, values, maps) {
  return (values || []).map(v => (maps[`${category}:${v}`] || {}).label || v);
}

// Parse a row's chroma_filters JSON array, falling back to the legacy single
// chroma_filter slug for any rows not yet migrated.
function rowFolders(row) {
  if (!row) return [];
  try {
    const arr = JSON.parse(row.chroma_filters || '[]');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch {}
  return row.chroma_filter ? [row.chroma_filter] : [];
}

// Flatten the ChromaDB folder slugs across all selected products into a unique
// list. Air-gapped POVs also pull the offline-deployment docs (mddownloader).
function chromaFoldersFor(productValues, deploymentValues, maps) {
  const folders = new Set();
  for (const v of productValues || []) {
    for (const f of rowFolders(maps[`product:${v}`])) folders.add(f);
  }
  if ((deploymentValues || []).includes('airgap')) folders.add('mddownloader');
  return [...folders];
}

// Split the model output on 'SECTION N: Name' headers into an ordered map.
// Tolerates leading Markdown heading marks / bold / whitespace (e.g.
// '## SECTION 1: Purpose' or '**SECTION 1:**') that models sometimes add,
// and normalizes the stored key to a clean 'SECTION N: Name'.
function parseSections(text) {
  const sections = {};
  const re = /^\s{0,3}#{0,6}\s*\**\s*SECTION\s+\d+\s*:.*$/gim;
  const matches = [...text.matchAll(re)];
  if (!matches.length) {
    sections['Document'] = text.trim();
    return sections;
  }
  const cleanKey = (h) => h.replace(/^\s*#{0,6}\s*/, '').replace(/\*\*/g, '').trim();
  for (let i = 0; i < matches.length; i++) {
    const header = cleanKey(matches[i][0]);
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections[header] = text.slice(start, end).trim();
  }
  return sections;
}

function serializeDraft(row) {
  let section_texts = {};
  let sources = [];
  let selections = null;
  try { section_texts = row.section_texts ? JSON.parse(row.section_texts) : {}; } catch {}
  try { sources = row.sources ? JSON.parse(row.sources) : []; } catch {}
  try { selections = row.selections ? JSON.parse(row.selections) : null; } catch {}
  return { ...row, section_texts, sources, selections };
}

function buildSearchQuery(account, dealIntel) {
  const parts = [
    account.ai_technical_drivers,
    account.ai_environment,
    dealIntel.business_pain,
    dealIntel.evaluation_criteria
  ].filter(Boolean);
  return parts.join(' \n ').slice(0, 500);
}

function dealIntelMap(accountId) {
  const out = {};
  db.prepare('SELECT field, value FROM deal_intelligence WHERE account_id = ?')
    .all(accountId)
    .forEach(r => { out[r.field] = r.value; });
  return out;
}

// ---------------------------------------------------------------------------
// Core generation pipeline (ChromaDB query + Anthropic + save). Runs detached
// from the HTTP request so generation survives client navigation. Returns the
// new pov_draft id.
// ---------------------------------------------------------------------------
async function generateDraft(accountId, body, key, locals) {
  {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!account) { const e = new Error('Account not found'); e.status = 404; throw e; }

    const maps = loadPovConfigMaps();
    // SE notes are intentionally NOT sent to the model (and not logged — they're private).
    const di = dealIntelMap(accountId);
    const notes = db.prepare(
      'SELECT * FROM notes WHERE account_id = ? AND deleted_at IS NULL ORDER BY date DESC'
    ).all(accountId);
    // The generated POV is a customer deliverable, so partner/internal names
    // are excluded unless the request explicitly opts in.
    const contacts = contactsForAccount(db, accountId, {
      customerOnly: !body.include_non_customer_contacts
    });

    // 2. search query
    const query = buildSearchQuery(account, di) ||
      `${account.account_name} ${(body.selected_products || []).join(' ')}`;

    // 3. Embed the query via the host embed server, then retrieve from ChromaDB.
    let chunks = [];
    let embedFailed = false;
    try {
      console.log('[pov] Building search query');
      console.log('[pov] Query:', query ? query.slice(0, 100) : '');
      console.log('[pov] Calling embed server...');
      const embedding = await getEmbedding(query);
      console.log('[pov] Embedding length:', embedding ? embedding.length : 0);
      const uniqueFolders = chromaFoldersFor(body.selected_products, body.selected_deployment, maps);
      const where = uniqueFolders.length ? { product: { $in: uniqueFolders } } : undefined;
      console.log('[pov] ChromaDB folders:', uniqueFolders.join(', ') || '(none)');
      chunks = await queryDocs({ chromaUrl: locals.chromaUrl, embedding, nResults: 15, where });
      console.log('[pov] ChromaDB results:', chunks.length);
    } catch (e) {
      embedFailed = true;
      console.error('[pov] Error:', e.message, e.stack);
    }

    const lowConfidence = chunks.filter(c => c.distance != null && c.distance > LOW_CONFIDENCE_DISTANCE);
    const sources = [...new Set(chunks.map(c => c.metadata && c.metadata.url).filter(Boolean))];

    // 5. user prompt
    const contactLines = contacts.length
      ? contacts.map(c => `- ${c.name}${c.title ? `, ${c.title}` : ''}${c.meddpicc_role ? ` (${c.meddpicc_role})` : ''}`).join('\n')
      : '(none recorded)';

    const docBlocks = chunks.map(c =>
      `--- Source: ${c.metadata.url || 'n/a'} | Product: ${c.metadata.product || 'n/a'} ---\n${c.document}`
    ).join('\n\n');

    const lowConfBlock = lowConfidence.length
      ? `\nNOTE: The following sections had limited documentation coverage -- flag them for manual review:\n` +
        [...new Set(lowConfidence.map(c => c.metadata.product || 'general'))].join(', ')
      : '';

    const optional = [];
    if (body.success_criteria_override) optional.push(`USE THESE EXACT SUCCESS CRITERIA (do not generate alternatives):\n${body.success_criteria_override}`);
    if (body.known_risks) optional.push(`INCLUDE THESE RISKS IN SECTION 10:\n${body.known_risks}`);
    if (body.competitors) optional.push(`USE THESE COMPETITORS IN SECTION 11:\n${body.competitors}`);
    if (body.additional_context) optional.push(`ADDITIONAL CONTEXT:\n${body.additional_context}`);

    const userPrompt =
`ACCOUNT CONTEXT:
Account: ${body.account_name_override || account.account_name} | Industry: ${account.industry || 'n/a'} | Stage: ${account.presales_stage || account.opportunity_stage || 'n/a'}
Close date: ${account.close_date || 'n/a'} | Value: ${account.opportunity_value || 'n/a'}

CONTACTS:
${contactLines}

DEAL INTELLIGENCE:
Business pain: ${di.business_pain || 'n/a'}
Evaluation criteria: ${di.evaluation_criteria || 'n/a'}
Decision maker: ${di.decision_maker || 'n/a'}
Internal champion: ${di.internal_champion || 'n/a'}
Competitive landscape: ${di.competitive_landscape || 'n/a'}
Success metrics: ${di.success_metrics || 'n/a'}

TECHNICAL CONTEXT FROM NOTES:
Technical drivers: ${account.ai_technical_drivers || 'n/a'}
Current environment: ${account.ai_environment || 'n/a'}
Product gaps: ${(notes[0] && notes[0].raw_notes ? notes[0].raw_notes.slice(0, 600) : 'n/a')}

PREFLIGHT SELECTIONS:
Products: ${labelsFor('product', body.selected_products, maps).join(', ') || 'n/a'}
Deployment: ${labelsFor('deployment', body.selected_deployment, maps).join(', ') || 'n/a'}
OS: ${labelsFor('os', body.selected_os, maps).join(', ') || 'n/a'}
Use cases: ${labelsFor('use_case', body.selected_use_cases, maps).join(', ') || 'n/a'}
Integrations: ${labelsFor('integration', body.selected_integrations, maps).join(', ') || 'n/a'}
Technologies in scope: ${labelsFor('technology', body.selected_technologies, maps).join(', ') || 'n/a'}
Metascan Windows engine tier: ${body.metascan_windows_tier ? labelsFor('technology', [body.metascan_windows_tier], maps)[0] : 'n/a'}
Metascan Linux engine tier: ${body.metascan_linux_tier ? labelsFor('technology', [body.metascan_linux_tier], maps)[0] : 'n/a'}
File types in scope: ${labelsFor('file_type', body.selected_file_types, maps).join(', ') || 'n/a'}
Compliance frameworks: ${labelsFor('compliance', body.selected_compliance, maps).join(', ') || 'n/a'}
Network topology: ${body.network_topology || 'n/a'}
Existing security stack: ${body.existing_stack || 'n/a'}
Competitors: ${body.competitors || 'n/a'}
Endpoint / user count: ${body.endpoint_count || body.user_count || 'n/a'}
${body.duration ? `Duration: ${body.duration}` : ''}

${optional.join('\n\n')}

RELEVANT OPSWAT DOCUMENTATION (use for deployment steps and prerequisites -- cite source URLs inline):
${docBlocks || '(no documentation chunks retrieved -- flag deployment sections for manual verification)'}
${lowConfBlock}

${SECTION_SPEC}`;

    // 6. generate
    const povText = await callAnthropic({
      key, model: POV_MODEL, max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    // 7. parse sections
    const sectionTexts = parseSections(povText);

    // If embedding failed we have no documentation sources — surface a clear
    // warning at the top of Section 1 so the SE knows to start the embed server.
    if (embedFailed) {
      const s1 = Object.keys(sectionTexts).find(k => /SECTION\s*1\b/i.test(k));
      if (s1) sectionTexts[s1] = `${EMBED_FAIL_BANNER}\n\n${sectionTexts[s1]}`;
      else sectionTexts['Notice'] = EMBED_FAIL_BANNER;
    }

    // 8. SE prep notes (separate call)
    let sePrep = '';
    try {
      sePrep = await callAnthropic({
        key, model: POV_MODEL, max_tokens: 1500,
        system: 'You are an expert OPSWAT Solutions Engineer writing private internal preparation notes.',
        messages: [{ role: 'user', content:
`Based on this account context and POV, generate private SE preparation notes covering: (1) anticipated customer objections and how to address them, (2) technical gotchas for this specific product/deployment combination, (3) 3-5 questions to ask at kickoff, (4) suggested demo flow sequence. Be specific to this customer's environment. Format as four labeled sections.

ACCOUNT: ${account.account_name} | Industry: ${account.industry || 'n/a'}
Products: ${labelsFor('product', body.selected_products, maps).join(', ')}
Deployment: ${labelsFor('deployment', body.selected_deployment, maps).join(', ')}
Business pain: ${di.business_pain || 'n/a'}
Competitive landscape: ${di.competitive_landscape || 'n/a'}

POV DOCUMENT:
${povText.slice(0, 6000)}` }]
      });
    } catch (e) {
      console.warn('[pov] SE prep notes generation failed:', e.message);
    }

    // 9. persist
    const color = POV_COLORS[db.prepare('SELECT COUNT(*) AS n FROM pov_drafts').get().n % POV_COLORS.length];
    const selections = {
      products: body.selected_products || [],
      deployment: body.selected_deployment || [],
      os: body.selected_os || [],
      use_cases: body.selected_use_cases || [],
      integrations: body.selected_integrations || [],
      technologies: body.selected_technologies || [],
      metascan_windows_tier: body.metascan_windows_tier || null,
      metascan_linux_tier: body.metascan_linux_tier || null,
      file_types: body.selected_file_types || [],
      compliance: body.selected_compliance || [],
      network_topology: body.network_topology || null,
      existing_stack: body.existing_stack || null,
      competitors: body.competitors || null,
      duration: body.duration || null,
      contact_name: body.contact_name || null,
      contact_title: body.contact_title || null,
      user_count: body.user_count || null,
      endpoint_count: body.endpoint_count || null,
      // Private SE planning notes — stored for the record, never sent to the AI
      // and never included in exports (export reads section_texts + se_prep_notes only).
      se_notes: body.se_notes || null
    };
    const info = db.prepare(`
      INSERT INTO pov_drafts
        (account_id, pov_text, section_texts, se_prep_notes, model_used, chunks_used, sources, status, color, start_date, end_date, selections)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(
      accountId, povText, JSON.stringify(sectionTexts), sePrep || null,
      POV_MODEL, chunks.length, JSON.stringify(sources), color,
      body.start_date || null, body.end_date || null, JSON.stringify(selections)
    );
    const povId = info.lastInsertRowid;

    const insertRev = db.prepare(`
      INSERT INTO pov_revision_history (pov_draft_id, section_key, old_text, new_text, reason, change_type)
      VALUES (?, ?, NULL, ?, 'Initial generation', 'initial')
    `);
    const recordInitial = db.transaction((entries) => {
      for (const [key2, val] of entries) insertRev.run(povId, key2, val);
    });
    recordInitial(Object.entries(sectionTexts));

    return povId;
  }
}

// Run a generation job to completion, recording status in pov_jobs. Detached
// from any request — safe to call without awaiting.
async function runPovJob(jobId, accountId, body, key, locals) {
  db.prepare("UPDATE pov_jobs SET status = 'running' WHERE id = ?").run(jobId);
  try {
    const povId = await generateDraft(accountId, body, key, locals);
    db.prepare("UPDATE pov_jobs SET status = 'complete', result_pov_id = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(povId, jobId);
  } catch (err) {
    console.error('[pov] generation job failed:', err);
    db.prepare("UPDATE pov_jobs SET status = 'error', error_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(err.message || 'Generation failed', jobId);
  }
}

// ---------------------------------------------------------------------------
// POST /api/accounts/:id/pov -- start generation in the background, return a
// job id immediately so the work survives client navigation.
// ---------------------------------------------------------------------------
router.post('/accounts/:id/pov', (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const key = getKey(req);
  if (!key) return res.status(400).json({ error: 'Anthropic API key required. Add it in Settings.' });

  const jobId = uuid();
  db.prepare("INSERT INTO pov_jobs (id, account_id, status) VALUES (?, ?, 'pending')")
    .run(jobId, req.params.id);

  // Respond first; capture stable references for the detached run.
  res.status(202).json({ job_id: jobId });

  const body = req.body || {};
  const locals = req.app.locals;
  runPovJob(jobId, req.params.id, body, key, locals);
});

// GET job status for polling.
router.get('/pov-jobs/:job_id', (req, res) => {
  const job = db.prepare('SELECT status, result_pov_id, error_message FROM pov_jobs WHERE id = ?')
    .get(req.params.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET all non-deleted POV drafts for an account, newest first.
router.get('/accounts/:id/pov', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM pov_drafts WHERE account_id = ? AND deleted_at IS NULL ORDER BY generated_at DESC, id DESC'
  ).all(req.params.id);
  res.json(rows.map(serializeDraft));
});

// PUT update a single section + record revision.
router.put('/accounts/:id/pov/:povId/section/:sectionKey', (req, res) => {
  const draft = db.prepare('SELECT * FROM pov_drafts WHERE id = ? AND account_id = ?')
    .get(req.params.povId, req.params.id);
  if (!draft) return res.status(404).json({ error: 'POV draft not found' });

  const { text, reason } = req.body || {};
  if (text == null) return res.status(400).json({ error: 'text required' });

  let sections = {};
  try { sections = draft.section_texts ? JSON.parse(draft.section_texts) : {}; } catch {}
  const oldText = sections[req.params.sectionKey] || '';
  sections[req.params.sectionKey] = text;

  db.prepare('UPDATE pov_drafts SET section_texts = ? WHERE id = ?')
    .run(JSON.stringify(sections), draft.id);
  db.prepare(`
    INSERT INTO pov_revision_history (pov_draft_id, section_key, old_text, new_text, reason, change_type)
    VALUES (?, ?, ?, ?, ?, 'manual')
  `).run(draft.id, req.params.sectionKey, oldText, text, reason || null);

  res.json({ section_key: req.params.sectionKey, text });
});

// POST regenerate a single section via Anthropic.
router.post('/accounts/:id/pov/:povId/section/:sectionKey/regenerate', async (req, res, next) => {
  try {
    const draft = db.prepare('SELECT * FROM pov_drafts WHERE id = ? AND account_id = ?')
      .get(req.params.povId, req.params.id);
    if (!draft) return res.status(404).json({ error: 'POV draft not found' });
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);

    const key = getKey(req);
    if (!key) return res.status(400).json({ error: 'Anthropic API key required.' });

    const { reason, existing_sections } = req.body || {};
    let sections = {};
    try { sections = draft.section_texts ? JSON.parse(draft.section_texts) : {}; } catch {}
    const oldText = sections[req.params.sectionKey] || '';
    const di = dealIntelMap(req.params.id);

    const otherSections = existing_sections || sections;
    const continuity = Object.entries(otherSections)
      .filter(([k]) => k !== req.params.sectionKey)
      .map(([k, v]) => `${k}:\n${String(v).slice(0, 800)}`)
      .join('\n\n');

    const userPrompt =
`Regenerate ONLY the section "${req.params.sectionKey}" of an OPSWAT PoV document for account ${account.account_name} (industry: ${account.industry || 'n/a'}).
${reason ? `Reason for regeneration: ${reason}\n` : ''}
Business pain: ${di.business_pain || 'n/a'}
Evaluation criteria: ${di.evaluation_criteria || 'n/a'}

For continuity, here are the OTHER sections of the document (do not rewrite them, just stay consistent):
${continuity}

Return ONLY the new content for "${req.params.sectionKey}" -- no section header, no preamble.`;

    const newText = await callAnthropic({
      key, model: POV_MODEL, max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    sections[req.params.sectionKey] = newText;
    db.prepare('UPDATE pov_drafts SET section_texts = ? WHERE id = ?')
      .run(JSON.stringify(sections), draft.id);
    db.prepare(`
      INSERT INTO pov_revision_history (pov_draft_id, section_key, old_text, new_text, reason, change_type)
      VALUES (?, ?, ?, ?, ?, 'regenerated')
    `).run(draft.id, req.params.sectionKey, oldText, newText, reason || null);

    res.json({ new_text: newText, old_text: oldText });
  } catch (err) {
    next(err);
  }
});

// PUT update POV metadata (status, win/loss, dates).
router.put('/accounts/:id/pov/:povId', (req, res) => {
  const draft = db.prepare('SELECT * FROM pov_drafts WHERE id = ? AND account_id = ?')
    .get(req.params.povId, req.params.id);
  if (!draft) return res.status(404).json({ error: 'POV draft not found' });

  const allowed = ['status', 'win_loss', 'win_loss_note', 'start_date', 'end_date', 'se_prep_notes'];
  const updates = [];
  const values = [];
  for (const f of allowed) {
    if (f in req.body) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (!updates.length) return res.json(serializeDraft(draft));
  values.push(draft.id);
  db.prepare(`UPDATE pov_drafts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(serializeDraft(db.prepare('SELECT * FROM pov_drafts WHERE id = ?').get(draft.id)));
});

// DELETE (soft) a POV draft.
router.delete('/pov-drafts/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM pov_drafts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'POV draft not found' });
  db.prepare('UPDATE pov_drafts SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  // Remove the POV's scheduled meetings so they don't linger as orphans.
  db.prepare('DELETE FROM pov_meetings WHERE pov_id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET revision history for a draft, newest first.
router.get('/pov-drafts/:id/revisions', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM pov_revision_history WHERE pov_draft_id = ? ORDER BY changed_at DESC, id DESC'
  ).all(req.params.id);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// POV timeline endpoints (calendar). A timeline is a pov_draft with both
// start_date and end_date set; manual ones have manually_created = 1.
// ---------------------------------------------------------------------------
const TIMELINE_COLORS = POV_COLORS;

// POST a manual timeline.
router.post('/pov-timeline', (req, res) => {
  const { account_id, start_date, end_date, label, status } = req.body || {};
  if (!account_id || !start_date || !end_date) {
    return res.status(400).json({ error: 'account_id, start_date and end_date required' });
  }
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(account_id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (new Date(end_date) <= new Date(start_date)) {
    return res.status(400).json({ error: 'end_date must be after start_date' });
  }
  const color = TIMELINE_COLORS[db.prepare('SELECT COUNT(*) AS n FROM pov_drafts').get().n % TIMELINE_COLORS.length];
  const info = db.prepare(`
    INSERT INTO pov_drafts
      (account_id, pov_text, section_texts, status, color, start_date, end_date, manually_created, label)
    VALUES (?, '', NULL, ?, ?, ?, ?, 1, ?)
  `).run(account_id, status || 'draft', color, start_date, end_date, label || null);
  res.status(201).json(serializeDraft(db.prepare('SELECT * FROM pov_drafts WHERE id = ?').get(info.lastInsertRowid)));
});

// Valid POV meeting types (kept in sync with the calendar UI).
const MEETING_TYPES = ['scoping', 'kickoff', 'checkin', 'wrapup'];

// GET all non-deleted timelines (manual + generated) with account info, each
// with its attached POV meetings (scoping call, kickoff, check-in, wrap-up).
router.get('/pov-timeline', (_req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.account_id, a.account_name, a.color AS account_color,
           p.label, p.start_date, p.end_date, p.status, p.win_loss, p.manually_created
    FROM pov_drafts p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.deleted_at IS NULL AND p.start_date IS NOT NULL AND p.end_date IS NOT NULL
    ORDER BY p.start_date ASC
  `).all();

  const meetings = db.prepare(
    'SELECT id, pov_id, type, meeting_date FROM pov_meetings ORDER BY meeting_date ASC'
  ).all();
  const byPov = {};
  for (const m of meetings) (byPov[m.pov_id] ||= []).push(m);
  rows.forEach(r => { r.meetings = byPov[r.id] || []; });

  res.json(rows);
});

// POST add a meeting to a POV timeline.
router.post('/pov-meetings', (req, res) => {
  const { pov_id, type, meeting_date } = req.body || {};
  if (!pov_id || !type || !meeting_date) {
    return res.status(400).json({ error: 'pov_id, type and meeting_date required' });
  }
  if (!MEETING_TYPES.includes(type)) {
    return res.status(400).json({ error: `Invalid meeting type: ${type}` });
  }
  const pov = db.prepare('SELECT id FROM pov_drafts WHERE id = ? AND deleted_at IS NULL').get(pov_id);
  if (!pov) return res.status(404).json({ error: 'POV timeline not found' });

  const info = db.prepare(
    'INSERT INTO pov_meetings (pov_id, type, meeting_date) VALUES (?, ?, ?)'
  ).run(pov_id, type, meeting_date);
  res.status(201).json(db.prepare('SELECT id, pov_id, type, meeting_date FROM pov_meetings WHERE id = ?').get(info.lastInsertRowid));
});

// DELETE a meeting.
router.delete('/pov-meetings/:id', (req, res) => {
  const m = db.prepare('SELECT id FROM pov_meetings WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  db.prepare('DELETE FROM pov_meetings WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// PUT update a timeline's label / dates / status.
router.put('/pov-timeline/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM pov_drafts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Timeline not found' });

  const body = req.body || {};
  const start = ('start_date' in body) ? body.start_date : existing.start_date;
  const end = ('end_date' in body) ? body.end_date : existing.end_date;
  if (start && end && new Date(end) <= new Date(start)) {
    return res.status(400).json({ error: 'end_date must be after start_date' });
  }

  const allowed = ['label', 'start_date', 'end_date', 'status'];
  const updates = [];
  const values = [];
  for (const f of allowed) {
    if (f in body) { updates.push(`${f} = ?`); values.push(body[f]); }
  }
  if (updates.length) {
    values.push(req.params.id);
    db.prepare(`UPDATE pov_drafts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
  res.json(serializeDraft(db.prepare('SELECT * FROM pov_drafts WHERE id = ?').get(req.params.id)));
});

// DELETE a timeline — only manual ones may be removed from the calendar.
router.delete('/pov-timeline/:id', (req, res) => {
  const existing = db.prepare('SELECT id, manually_created FROM pov_drafts WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Timeline not found' });
  if (!existing.manually_created) {
    return res.status(403).json({ error: 'Generated POV timelines cannot be deleted from the calendar. Manage them from the account page.' });
  }
  db.prepare('UPDATE pov_drafts SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM pov_meetings WHERE pov_id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
