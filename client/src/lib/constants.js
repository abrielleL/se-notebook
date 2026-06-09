// Shared domain constants for the SE notebook feature set.
// NOTE: the 8 qualification fields are driven internally by a sales
// framework, but that framework name is never surfaced in the UI.

// Presales stages live in stages.js (single source of truth); re-export so
// existing imports from constants keep working.
import { PRESALES_STAGES, STAGE_COLORS, stageColor } from './stages.js';
export { PRESALES_STAGES, STAGE_COLORS, stageColor };

// The 8 clickable steps in the stage bar.
export const STAGE_BAR = PRESALES_STAGES.slice(0, 8);
// Non-progression / terminal stages shown after the numbered steps.
export const EXTRA_STAGES = PRESALES_STAGES.slice(8); // Not Required, Stalled, Canceled

export function nextStage(stage) {
  const i = STAGE_BAR.indexOf(stage);
  if (i === -1 || i >= STAGE_BAR.length - 1) return null;
  return STAGE_BAR[i + 1];
}

// Stage bar cell styling.
export function stageBarStyle(stage, currentStage) {
  const idx = STAGE_BAR.indexOf(stage);
  const curIdx = STAGE_BAR.indexOf(currentStage);
  if (stage === '8-Technical Loss' && currentStage === '8-Technical Loss') {
    return { bg: '#2d0d0d', text: '#f85149' };           // loss = red
  }
  if (currentStage && idx === curIdx) return { bg: '#1a2744', text: '#58a6ff' }; // active = blue
  if (currentStage && idx < curIdx) return { bg: '#0d2a1a', text: '#26a641' };   // done = green
  return { bg: '#10141b', text: '#8b949e' };
}

// Risk: company-exact definitions (Critical Note 7).
export const RISK_OPTIONS = [
  { value: 'green', label: 'Green', dot: '#3fb950', desc: 'Evaluation progressing, no detectable risk' },
  { value: 'yellow', label: 'Yellow', dot: '#e3b341', desc: 'Risk to technical fit or timing, or struggling to differentiate against alternatives' },
  { value: 'red', label: 'Red', dot: '#f85149', desc: 'Clear risk to technical fit or timing, or not differentiated against alternatives or "do nothing"' }
];
export function riskDot(risk) {
  const r = RISK_OPTIONS.find(o => o.value === risk);
  return r ? r.dot : '#4a5568';
}

export const ESCALATION_OPTIONS = ['Tech Blocked', 'Tech Challenged', 'Not Needed'];
export function escalationStyle(esc) {
  if (esc === 'Tech Blocked') return { bg: '#2d0d0d', text: '#f85149' };
  if (esc === 'Tech Challenged') return { bg: '#2d2200', text: '#e3b341' };
  return { bg: '#10141b', text: '#8b949e' };
}

// 8 qualification fields, row-major for the 2x4 grid. Plain-English labels only.
export const QUAL_FIELDS = [
  { key: 'success_metrics', label: 'Success metrics' },
  { key: 'decision_maker', label: 'Decision maker' },
  { key: 'evaluation_criteria', label: 'Evaluation criteria' },
  { key: 'buying_process', label: 'Buying process' },
  { key: 'paper_process', label: 'Paper process' },
  { key: 'business_pain', label: 'Business pain' },
  { key: 'internal_champion', label: 'Internal champion' },
  { key: 'competitive_landscape', label: 'Competitive landscape' }
];

// Contact qualification-role badges.
export const ROLE_BADGES = {
  decision_maker: { label: 'DM', color: '#58a6ff' },
  champion: { label: 'CH', color: '#3fb950' },
  technical_lead: { label: 'TL', color: '#8b949e' },
  influencer: { label: 'IN', color: '#8b949e' },
  procurement: { label: 'PR', color: '#e3b341' }
};
export const ROLE_OPTIONS = [
  { value: '', label: '— No role —' },
  { value: 'decision_maker', label: 'Decision maker' },
  { value: 'champion', label: 'Champion' },
  { value: 'technical_lead', label: 'Technical lead' },
  { value: 'influencer', label: 'Influencer' },
  { value: 'procurement', label: 'Procurement' }
];

// Stage gate definitions (frontend config).
export const STAGE_GATES = {
  '5-Deployment': [
    { key: 'pov_plan_agreed', label: 'POV Success Plan agreed by all parties' },
    { key: 'kickoff_confirmed', label: 'Kickoff date confirmed with customer' },
    { key: 'prereqs_shared', label: 'Prerequisites checklist shared' },
    { key: 'offline_license', label: 'Offline license staged (if air-gapped)' }
  ],
  '6-In Progress': [
    { key: 'kickoff_complete', label: 'Kickoff completed' },
    { key: 'criteria_agreed', label: 'Success criteria agreed and documented' },
    { key: 'checkin_cadence', label: 'Regular check-in cadence established' },
    { key: 'paper_process', label: 'Paper process identified' }
  ],
  '7-Technical Win': [
    { key: 'criteria_met', label: 'All success criteria marked or documented' },
    { key: 'verbal_win', label: 'Customer acknowledged technical differentiation' },
    { key: 'commercial_next', label: 'Commercial next step agreed' },
    { key: 'closeout_scheduled', label: 'Close-out meeting scheduled' }
  ],
  'Stalled': [
    { key: 'stall_reason', label: 'Stall reason documented in notes' },
    { key: 'reengage_trigger', label: 'Re-engage trigger or date identified' }
  ]
};

export const EMAIL_TYPES = [
  { value: 'pov-followup', label: 'POV follow-up after check-in' },
  { value: 'pre-kickoff', label: 'Pre-kickoff prep email' },
  { value: 'technical-escalation', label: 'Technical escalation' },
  { value: 'closeout-summary', label: 'Close-out summary' },
  { value: 'custom', label: 'Custom prompt…' }
];


export const NOTE_TYPES = [
  'Discovery', 'Demo', 'Workshop', 'Technical call', 'Check-in',
  'Kickoff', 'Email', 'Transcript', 'General'
];

export const POV_STATUSES = ['Draft', 'Sent', 'Kicked Off', 'In Progress', 'Closed'];

export const DURATION_OPTIONS = ['2 weeks', '1 week', '30 days', 'Custom'];

export const EXPORT_SECTIONS = [
  { key: 'summary', label: 'AI summary' },
  { key: 'drivers', label: 'Technical drivers' },
  { key: 'environment', label: 'Environment' },
  { key: 'next_steps', label: 'Next steps' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'qualification', label: 'Account qualification' },
  { key: 'notes', label: 'Note history' },
  { key: 'crm_snapshot', label: 'CRM snapshot' },
  { key: 'active_pov', label: 'Active POV' },
  { key: 'se_prep_notes', label: 'SE prep notes', private: true },
  { key: 'attachments', label: 'Attachments' }
];
export const EXPORT_PRESETS = {
  customer: ['summary', 'drivers', 'environment', 'next_steps', 'contacts'],
  full: EXPORT_SECTIONS.map(s => s.key)
};

// Account aging dot color from days since last note.
export function agingColor(days, hasNote) {
  if (!hasNote || days == null) return '#4a5568';   // gray
  if (days <= 7) return '#3fb950';                   // green
  if (days <= 30) return '#e3b341';                  // amber
  return '#f85149';                                  // red
}

// Due-date urgency color.
export function dueColor(dueDate) {
  if (!dueDate) return '#8b949e';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dueDate); d.setHours(0, 0, 0, 0);
  if (d < today) return '#f85149';   // overdue red
  if (d.getTime() === today.getTime()) return '#e3b341'; // today amber
  return '#8b949e';
}

// POV preflight: live complexity estimate.
export function povComplexity({ products = [], deployment = [], integrations = [] }) {
  const score = products.length + integrations.length +
    (deployment.includes('airgap') ? 2 : 0) +
    (deployment.includes('hybrid') ? 1 : 0);
  const level = score <= 2 ? 'Low' : score <= 5 ? 'Medium' : 'High';
  const hours = 4 + products.length * 3 + integrations.length * 2 +
    (deployment.includes('airgap') ? 8 : 0);
  return { level, hours, recommended: '1 SE + 1 customer IT admin' };
}

// POV preflight: soft conflict warnings (slug-only checks; richer, config-aware
// conflict detection lives in PovGenerator where valid_deployments is available).
export function povConflicts({ products = [], deployment = [] }) {
  const warnings = [];
  const requireOnPrem = ['mdkiosk', 'mddrive', 'mddrive-smart', 'mdnetwall', 'mdoptical', 'mdusg', 'mdbsg', 'mddiodex', 'fenddiode', 'mdmediafirewall'];
  const cloudDeployments = ['aws', 'gcp', 'azure', 'saas'];
  if (deployment.some(d => cloudDeployments.includes(d)) && products.some(p => requireOnPrem.includes(p))) {
    warnings.push('Some selected products require on-premises, hardware, or air-gapped deployment.');
  }
  if (deployment.includes('airgap') && products.includes('mdcloud')) {
    warnings.push('MetaDefender Cloud requires internet connectivity.');
  }
  return warnings;
}

// Ordered product groupings for the POV generator's "Products in scope" card.
// Group headers render in this order; products not listed fall under "Other".
export const PRODUCT_GROUPS = [
  { label: 'File Security', values: ['mdcore', 'mdicap', 'mdicap-cloud', 'mdss', 'mdss-cloud', 'mdfs'] },
  { label: 'Email Security', values: ['mdemail', 'mdemail-cloud'] },
  { label: 'Managed File Transfer', values: ['mdmft'] },
  { label: 'Removable Media & Endpoint', values: ['mdkiosk', 'mdmediafirewall', 'mdendpoint', 'mddrive', 'mddrive-smart'] },
  { label: 'Zero-Day & Threat Intel', values: ['mdaether', 'mdaether-cloud', 'mdti', 'mdinsights-c2', 'mdinsights-ti', 'mdinsights-osint', 'filescan'] },
  { label: 'Network & Detection', values: ['mdndr', 'mdnac'] },
  { label: 'OT & Cyber-Physical', values: ['mdot', 'mdot-access', 'mdif'] },
  { label: 'Cross-Domain Solutions', values: ['mdnetwall', 'mdoptical', 'mdusg', 'mdbsg', 'mddiodex', 'fenddiode'] },
  { label: 'Cloud & Management', values: ['mdcloud', 'myop'] },
  { label: 'Supply Chain', values: ['mdsupplychain'] },
  { label: 'Infrastructure', values: ['mdcluster'] },
  { label: 'OEM / Developer', values: ['oesis', 'mdsdk'] }
];
