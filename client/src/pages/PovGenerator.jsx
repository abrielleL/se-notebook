import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DatePicker from 'react-datepicker';
import { api } from '../lib/api.js';
import Icon from '../components/Icons.jsx';
import TablerIcon from '../components/TablerIcon.jsx';
import Modal from '../components/Modal.jsx';
import ExportModal from '../components/ExportModal.jsx';
import { useToast } from '../components/Toast.jsx';
import { useOnline } from '../lib/offline.jsx';
import Markdown from '../components/Markdown.jsx';
import EditableMarkdown from '../components/EditableMarkdown.jsx';
import { usePovJob } from '../lib/povJob.js';
import { generateKickoffAgenda } from '../lib/ai.js';
import { formatDate, todayISO, parseISODate, toISODate } from '../lib/stage.js';
import { DURATION_OPTIONS, POV_STATUSES, povComplexity, PRODUCT_GROUPS } from '../lib/constants.js';

// Generic single-list chip categories (products/deployment/technologies/file
// types/compliance get bespoke cards below).
const CATS = [
  { key: 'os', label: 'Operating system', multi: true },
  { key: 'use_case', label: 'Use cases', multi: true },
  { key: 'integration', label: 'Key integrations', multi: true }
];

function Chip({ item, active, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
      title={disabled ? 'Not supported by the selected product(s)' : undefined}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-[11px] transition ${
        disabled ? 'bg-card/40 border-border/50 text-text-dim opacity-40 cursor-not-allowed'
          : active ? 'bg-accent-blue/15 border-accent-blue/40 text-accent-blue' : 'bg-card border-border text-text-muted hover:text-text-primary'}`}>
      <TablerIcon name={item.icon} className="text-[13px]" />
      {item.label}
    </button>
  );
}

// Amber inline warning banner placed directly under the relevant card.
function ConflictBanner({ messages }) {
  if (!messages || !messages.length) return null;
  return (
    <div className="bg-[#2e1d18]/40 border border-[#5c3e2d] rounded-lg p-3 text-[11px] text-accent-yellow flex flex-col gap-1">
      {messages.map((m, i) => <div key={i}>⚠ {m}</div>)}
    </div>
  );
}

export default function PovGenerator() {
  const { id, povId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const online = useOnline();

  const [account, setAccount] = useState(null);
  const [config, setConfig] = useState(null);
  const [pov, setPov] = useState(null);
  const [mode, setMode] = useState(povId ? 'document' : 'preflight');
  const [submitting, setSubmitting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [similar, setSimilar] = useState([]);
  const [povVersion, setPovVersion] = useState(null);

  // Version of a POV within its account = its position by creation order (oldest = v1).
  const versionFromList = (list, targetId) => {
    const idx = [...list].sort((a, b) => a.id - b.id).findIndex(x => String(x.id) === String(targetId));
    return idx >= 0 ? idx + 1 : null;
  };

  // Background generation job: survives navigation, auto-resumes on return.
  // Disabled auto-resume when viewing an existing POV (povId in the URL).
  const { generating: jobGenerating, start: startPovJob } = usePovJob(id, {
    enabled: !povId,
    onComplete: async (resultPovId) => {
      try {
        const list = await api.listPov(id);
        const fresh = list.find(p => String(p.id) === String(resultPovId));
        if (fresh) {
          setPov(fresh);
          setPovVersion(versionFromList(list, resultPovId));
          setMode('document');
          navigate(`/accounts/${id}/pov-generator/${resultPovId}`, { replace: true });
        }
        toast('POV generated', 'success');
      } catch (e) { toast(e.message, 'error'); }
    },
    onError: (msg) => toast(`Generation failed: ${msg}`, 'error')
  });
  const generating = submitting || jobGenerating;

  const [form, setForm] = useState({
    account_name_override: '', contact_name: '', contact_title: '', duration: '2 weeks',
    start_date: todayISO(), end_date: '',
    selected_products: [], selected_deployment: [], selected_os: [], selected_use_cases: [], selected_integrations: [],
    selected_technologies: [], metascan_windows_tier: '', metascan_linux_tier: '',
    selected_file_types: [], selected_compliance: [],
    network_topology: '', existing_stack: '',
    success_criteria_override: '', known_risks: '', competitors: '', endpoint_count: '', additional_context: '', se_notes: ''
  });

  useEffect(() => {
    api.getPovConfig().then(setConfig).catch(() => {});
    api.getAccount(id).then(a => {
      setAccount(a);
      setForm(f => ({ ...f, account_name_override: a.account_name, contact_name: (a.contacts || [])[0]?.name || '', contact_title: (a.contacts || [])[0]?.title || '' }));
    }).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (povId) api.listPov(id).then(list => { const p = list.find(x => String(x.id) === String(povId)); if (p) { setPov(p); setMode('document'); } setPovVersion(versionFromList(list, povId)); }).catch(() => {});
  }, [povId, id]);

  // similar POV suggestions across other accounts
  useEffect(() => {
    if (mode !== 'preflight' || !form.selected_products.length) { setSimilar([]); return; }
    let cancelled = false;
    (async () => {
      const accts = await api.listAccounts().catch(() => []);
      const lists = await Promise.all(accts.filter(a => a.id !== id).map(a => api.listPov(a.id).then(l => l.map(p => ({ ...p, _account: a }))).catch(() => [])));
      const flat = lists.flat();
      const matches = flat.filter(p => p.selections && (p.selections.products || []).some(pr => form.selected_products.includes(pr)));
      if (!cancelled) setSimilar(matches.slice(0, 4));
    })();
    return () => { cancelled = true; };
  }, [mode, form.selected_products, id]);

  // Map a category key to its form field. (Previously this naively prefixed the
  // key, so 'product' -> 'selected_product' and 'integration' -> 'selected_integration',
  // neither of which matched the plural form/server fields — those selections were
  // silently dropped. This corrects that.)
  const FIELD_FOR = {
    product: 'selected_products', deployment: 'selected_deployment', os: 'selected_os',
    use_case: 'selected_use_cases', integration: 'selected_integrations'
  };
  function toggle(catKey, value, multi) {
    const field = FIELD_FOR[catKey] || `selected_${catKey}`;
    setForm(f => {
      const cur = f[field] || [];
      if (multi) return { ...f, [field]: cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value] };
      return { ...f, [field]: cur.includes(value) ? [] : [value] };
    });
  }
  function selectedFor(catKey) {
    const field = FIELD_FOR[catKey] || `selected_${catKey}`;
    return form[field] || [];
  }
  // Direct field helpers for the bespoke cards (technologies / file types / compliance).
  function toggleMulti(field, value) {
    setForm(f => { const cur = f[field] || []; return { ...f, [field]: cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value] }; });
  }
  function toggleSingle(field, value) {
    setForm(f => ({ ...f, [field]: f[field] === value ? '' : value }));
  }

  // Config-derived lookups.
  const prodByValue = useMemo(() => Object.fromEntries((config?.product || []).map(p => [p.value, p])), [config]);
  // Deployment chips are filtered to the union of valid_deployments across the
  // selected products. null = no products selected yet, so show everything.
  const allowedDeployments = useMemo(() => {
    if (!form.selected_products.length) return null;
    const set = new Set();
    for (const v of form.selected_products) for (const d of (prodByValue[v]?.valid_deployments || [])) set.add(d);
    return set;
  }, [form.selected_products, prodByValue]);

  const techItems = config?.technology || [];
  const winTiers = techItems.filter(t => t.value.startsWith('metascan-win-'));
  const linTiers = techItems.filter(t => t.value.startsWith('metascan-lin-'));
  const otherTechs = techItems.filter(t => !t.value.startsWith('metascan-'));

  const complexity = useMemo(() => povComplexity({ products: form.selected_products, deployment: form.selected_deployment, integrations: form.selected_integrations }), [form]);

  // Config-aware conflict detection, grouped by the card the warning sits under.
  const conflicts = useMemo(() => {
    const dep = form.selected_deployment || [];
    const out = { deployment: [], technology: [] };
    const cloud = ['aws', 'gcp', 'azure', 'saas'];
    const isSaasOnly = vd => vd && vd.length && vd.every(d => d === 'saas');
    const isHwOnly = vd => vd && vd.length && vd.every(d => d === 'hardware');
    if (dep.includes('airgap')) {
      for (const v of form.selected_products) {
        const p = prodByValue[v];
        if (p && isSaasOnly(p.valid_deployments)) out.deployment.push(`${p.label} is SaaS-only and can't run in an air-gapped deployment.`);
      }
    }
    if (dep.some(d => cloud.includes(d))) {
      for (const v of form.selected_products) {
        const p = prodByValue[v];
        if (p && isHwOnly(p.valid_deployments)) out.deployment.push(`${p.label} requires OPSWAT hardware and isn't available on a cloud deployment.`);
      }
    }
    if (form.metascan_windows_tier && !dep.includes('onprem-windows')) out.technology.push('A Metascan Windows engine tier is selected but no On-prem Windows deployment is chosen.');
    if (form.metascan_linux_tier && !dep.some(d => ['onprem-linux', 'container'].includes(d))) out.technology.push('A Metascan Linux engine tier is selected but no On-prem Linux / Containerized deployment is chosen.');
    if ((form.selected_technologies.includes('deep-cdr') || form.selected_technologies.includes('proactive-dlp')) && !(form.selected_file_types || []).length) {
      out.technology.push('Deep CDR / Proactive DLP is selected but no file types are specified — add the file types to be evaluated.');
    }
    return out;
  }, [form, prodByValue]);

  async function generate() {
    setSubmitting(true);
    try {
      const { job_id } = await api.generatePov(id, form);
      startPovJob(job_id);  // persists to localStorage + begins polling
      toast('POV generation started — you can navigate away; it will keep running.', 'info');
    } catch (e) {
      toast(`Generation failed: ${e.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  // Reopen the preflight form prefilled from an existing POV's stored inputs
  // (product selections, duration, timeline) so they can be reviewed/adjusted.
  function editInputs() {
    const s = (pov && pov.selections) || {};
    setForm(f => ({
      ...f,
      account_name_override: account?.account_name || f.account_name_override,
      contact_name: s.contact_name || f.contact_name,
      contact_title: s.contact_title || f.contact_title,
      duration: s.duration || f.duration,
      start_date: pov?.start_date || f.start_date,
      end_date: pov?.end_date || f.end_date,
      selected_products: s.products || [],
      selected_deployment: s.deployment || [],
      selected_os: s.os || [],
      selected_use_cases: s.use_cases || [],
      selected_integrations: s.integrations || [],
      selected_technologies: s.technologies || [],
      metascan_windows_tier: s.metascan_windows_tier || '',
      metascan_linux_tier: s.metascan_linux_tier || '',
      selected_file_types: s.file_types || [],
      selected_compliance: s.compliance || [],
      network_topology: s.network_topology || '',
      existing_stack: s.existing_stack || '',
      competitors: s.competitors || '',
      endpoint_count: s.user_count || f.endpoint_count
    }));
    setMode('preflight');
  }

  if (!account) return <div className="p-8 text-[12px] text-text-muted">Loading…</div>;

  // ---------- PREFLIGHT ----------
  if (mode === 'preflight') {
    return (
      <div className="p-6 max-w-3xl mx-auto flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate(`/accounts/${id}`)} className="text-text-dim hover:text-text-primary"><Icon.Back width={16} height={16} /></button>
          <h1 className="text-[15px] font-semibold text-text-primary flex-1">Generate POV — {account.account_name}</h1>
          {povId && pov && (
            <button onClick={() => setMode('document')} className="text-[11px] text-text-muted hover:text-accent-blue shrink-0">← Back to document</button>
          )}
        </div>

        {povId && pov && (
          <div className="px-3 py-2 rounded bg-[#2e1d18]/40 border border-[#5c3e2d] text-[11px] text-accent-yellow">
            Editing inputs for POV {povVersion ? `v${povVersion}` : `#${pov.id}`}. Generating will create a <strong>new version</strong> — your existing document is kept.
          </div>
        )}

        <div className="bg-card border border-border rounded-lg p-4 grid grid-cols-2 gap-3">
          <Labeled label="Account name"><input className={inputCls} value={form.account_name_override} onChange={e => setForm(f => ({ ...f, account_name_override: e.target.value }))} /></Labeled>
          <Labeled label="Industry"><input className={inputCls} value={account.industry || ''} disabled /></Labeled>
          <Labeled label="Contact name"><input className={inputCls} value={form.contact_name} onChange={e => setForm(f => ({ ...f, contact_name: e.target.value }))} /></Labeled>
          <Labeled label="Contact title"><input className={inputCls} value={form.contact_title} onChange={e => setForm(f => ({ ...f, contact_title: e.target.value }))} /></Labeled>
          <Labeled label="Duration"><select className={inputCls} value={form.duration} onChange={e => setForm(f => ({ ...f, duration: e.target.value }))}>{DURATION_OPTIONS.map(d => <option key={d}>{d}</option>)}</select></Labeled>
          <Labeled label="Start date"><DatePicker selected={parseISODate(form.start_date)} onChange={(d) => setForm(f => ({ ...f, start_date: toISODate(d) }))} dateFormat="MMM d, yyyy" placeholderText="Select date" className={inputCls} popperPlacement="bottom-start" /></Labeled>
          <Labeled label="End date"><DatePicker selected={parseISODate(form.end_date)} onChange={(d) => setForm(f => ({ ...f, end_date: toISODate(d) }))} dateFormat="MMM d, yyyy" placeholderText="Select date" className={inputCls} popperPlacement="bottom-start" /></Labeled>
        </div>

        {/* Products in scope — grouped by product family */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-[12px] font-medium text-text-primary mb-2">Products in scope</div>
          {!config ? (
            <div className="flex flex-wrap gap-2">{[0, 1, 2, 3].map(i => <div key={i} className="w-28 h-7 rounded bg-[#111f42] animate-pulse" />)}</div>
          ) : (
            <div className="flex flex-col gap-3">
              {(() => {
                const items = config.product || [];
                const byValue = Object.fromEntries(items.map(p => [p.value, p]));
                const grouped = PRODUCT_GROUPS.map(g => ({ label: g.label, items: g.values.map(v => byValue[v]).filter(Boolean) }));
                const known = new Set(PRODUCT_GROUPS.flatMap(g => g.values));
                const other = items.filter(p => !known.has(p.value));
                if (other.length) grouped.push({ label: 'Other', items: other });
                return grouped.filter(g => g.items.length).map(g => (
                  <div key={g.label}>
                    <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1.5">{g.label}</div>
                    <div className="flex flex-wrap gap-2">
                      {g.items.map(item => (
                        <Chip key={item.id} item={item} active={form.selected_products.includes(item.value)} onClick={() => toggle('product', item.value, true)} />
                      ))}
                    </div>
                  </div>
                ));
              })()}
            </div>
          )}
        </div>

        {/* Deployment — chips filtered to what the selected products support */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-[12px] font-medium text-text-primary mb-2">Deployment type</div>
          <div className="flex flex-wrap gap-2">
            {!config
              ? [0, 1, 2].map(i => <div key={i} className="w-24 h-7 rounded bg-[#111f42] animate-pulse" />)
              : (config.deployment || []).map(item => {
                const disabled = allowedDeployments != null && !allowedDeployments.has(item.value);
                return <Chip key={item.id} item={item} active={form.selected_deployment.includes(item.value)} disabled={disabled}
                  onClick={() => { if (!disabled) toggle('deployment', item.value, true); }} />;
              })}
          </div>
        </div>
        <ConflictBanner messages={conflicts.deployment} />

        {CATS.map(cat => (
          <div key={cat.key} className="bg-card border border-border rounded-lg p-4">
            <div className="text-[12px] font-medium text-text-primary mb-2">{cat.label}</div>
            <div className="flex flex-wrap gap-2">
              {!config
                ? [0, 1, 2].map(i => <div key={i} className="w-24 h-7 rounded bg-[#111f42] animate-pulse" />)
                : (config[cat.key] || []).map(item => (
                  <Chip key={item.id} item={item} active={selectedFor(cat.key).includes(item.value)} onClick={() => toggle(cat.key, item.value, cat.multi)} />
                ))}
            </div>
          </div>
        ))}

        {/* Technologies in scope */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-[12px] font-medium text-text-primary">Technologies in scope</div>
          <div className="text-[10px] text-text-muted mb-3">Evaluated through MetaDefender Core or MetaDefender Cloud</div>
          {!config ? (
            <div className="flex flex-wrap gap-2">{[0, 1, 2].map(i => <div key={i} className="w-24 h-7 rounded bg-[#111f42] animate-pulse" />)}</div>
          ) : (
            <div className="flex flex-col gap-3">
              {winTiers.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1.5">Metascan — Windows engine tier</div>
                  <div className="flex flex-wrap gap-2">
                    {winTiers.map(item => (
                      <Chip key={item.id} item={item} active={form.metascan_windows_tier === item.value} onClick={() => toggleSingle('metascan_windows_tier', item.value)} />
                    ))}
                  </div>
                </div>
              )}
              {linTiers.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1.5">Metascan — Linux engine tier</div>
                  <div className="flex flex-wrap gap-2">
                    {linTiers.map(item => (
                      <Chip key={item.id} item={item} active={form.metascan_linux_tier === item.value} onClick={() => toggleSingle('metascan_linux_tier', item.value)} />
                    ))}
                  </div>
                </div>
              )}
              {otherTechs.length > 0 && (
                <div className="border-t border-border pt-3 flex flex-wrap gap-2">
                  {otherTechs.map(item => (
                    <Chip key={item.id} item={item} active={form.selected_technologies.includes(item.value)} onClick={() => toggleMulti('selected_technologies', item.value)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <ConflictBanner messages={conflicts.technology} />

        {/* File types */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-[12px] font-medium text-text-primary mb-2">File types in scope</div>
          <div className="flex flex-wrap gap-2">
            {!config
              ? [0, 1, 2].map(i => <div key={i} className="w-24 h-7 rounded bg-[#111f42] animate-pulse" />)
              : (config.file_type || []).map(item => (
                <Chip key={item.id} item={item} active={form.selected_file_types.includes(item.value)} onClick={() => toggleMulti('selected_file_types', item.value)} />
              ))}
          </div>
        </div>

        {/* Compliance */}
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-[12px] font-medium text-text-primary mb-2">Compliance frameworks</div>
          <div className="flex flex-wrap gap-2">
            {!config
              ? [0, 1, 2].map(i => <div key={i} className="w-24 h-7 rounded bg-[#111f42] animate-pulse" />)
              : (config.compliance || []).map(item => (
                <Chip key={item.id} item={item} active={form.selected_compliance.includes(item.value)} onClick={() => toggleMulti('selected_compliance', item.value)} />
              ))}
          </div>
        </div>

        <div className="bg-[#111f42] border border-border rounded-lg p-3 text-[11px] text-text-muted">
          Estimated setup time: <span className="text-text-primary">{complexity.hours} hours</span> · Recommended: {complexity.recommended} · Complexity: <span className="text-text-primary">{complexity.level}</span>
          <span className="text-text-dim"> · </span>{form.selected_products.length} products · {form.selected_technologies.length + (form.metascan_windows_tier ? 1 : 0) + (form.metascan_linux_tier ? 1 : 0)} technologies · {form.selected_compliance.length} compliance
        </div>

        {similar.length > 0 && (
          <div className="bg-card border border-border rounded-lg p-3">
            <div className="text-[11px] text-text-muted mb-2">Similar POVs: {similar.map(s => s._account.account_name).join(', ')}</div>
            <button onClick={() => { const s = similar[0].selections || {}; setForm(f => ({ ...f, selected_products: s.products || [], selected_deployment: s.deployment || [], selected_os: s.os || [], selected_use_cases: s.use_cases || [], selected_integrations: s.integrations || [], selected_technologies: s.technologies || [], metascan_windows_tier: s.metascan_windows_tier || '', metascan_linux_tier: s.metascan_linux_tier || '', selected_file_types: s.file_types || [], selected_compliance: s.compliance || [] })); }}
              className="text-[11px] text-accent-blue hover:underline">Use as starting point</button>
          </div>
        )}

        <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
          <div className="text-[12px] font-medium text-text-primary">Optional overrides</div>
          <Labeled label="Success criteria (verbatim if provided)"><textarea className={inputCls} rows={2} value={form.success_criteria_override} onChange={e => setForm(f => ({ ...f, success_criteria_override: e.target.value }))} /></Labeled>
          <Labeled label="Known blockers / risks"><textarea className={inputCls} rows={2} value={form.known_risks} onChange={e => setForm(f => ({ ...f, known_risks: e.target.value }))} /></Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Competing products"><input className={inputCls} value={form.competitors} onChange={e => setForm(f => ({ ...f, competitors: e.target.value }))} /></Labeled>
            <Labeled label="Endpoint / user count"><input className={inputCls} value={form.endpoint_count} onChange={e => setForm(f => ({ ...f, endpoint_count: e.target.value }))} /></Labeled>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Network topology"><input className={inputCls} value={form.network_topology} onChange={e => setForm(f => ({ ...f, network_topology: e.target.value }))} placeholder="e.g. segmented OT network, DMZ" /></Labeled>
            <Labeled label="Existing security stack"><input className={inputCls} value={form.existing_stack} onChange={e => setForm(f => ({ ...f, existing_stack: e.target.value }))} placeholder="e.g. Palo Alto, CrowdStrike" /></Labeled>
          </div>
          <Labeled label="Additional context"><textarea className={inputCls} rows={2} value={form.additional_context} onChange={e => setForm(f => ({ ...f, additional_context: e.target.value }))} /></Labeled>
          <Labeled label="🔒 SE notes (private — never sent to the AI or included in exports)"><textarea className={inputCls} rows={2} value={form.se_notes} onChange={e => setForm(f => ({ ...f, se_notes: e.target.value }))} /></Labeled>
        </div>

        <div className="flex justify-end">
          <button onClick={generate} disabled={generating || !online} title={!online ? 'AI features require internet connection' : undefined}
            className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-5 py-2 text-[13px] font-medium hover:bg-accent-blue/25 disabled:opacity-40">
            {generating ? 'Generating POV (this can take a minute)…' : 'Generate POV document'}
          </button>
        </div>
      </div>
    );
  }

  // ---------- DOCUMENT VIEW ----------
  // The POV loads asynchronously; if it hasn't resolved yet (e.g. the account
  // fetch won the race), wait rather than rendering PovDocument with a null pov.
  if (!pov) return <div className="p-8 text-[12px] text-text-muted">Loading POV…</div>;

  return <PovDocument accountId={id} account={account} pov={pov} version={povVersion} setPov={setPov} navigate={navigate}
    onEditInputs={editInputs}
    onExport={() => setExportOpen(true)} exportOpen={exportOpen} onCloseExport={() => setExportOpen(false)} online={online} />;
}

const inputCls = 'w-full bg-[#040d1c] border border-border rounded px-2 py-1.5 text-[12px] text-text-primary focus:outline-none focus:border-accent-blue/50';
function Labeled({ label, children }) {
  return <div><label className="text-[10px] text-text-muted block mb-1">{label}</label>{children}</div>;
}

function PovDocument({ accountId, account, pov, version, setPov, navigate, onEditInputs, onExport, exportOpen, onCloseExport, online }) {
  const toast = useToast();
  const [sections, setSections] = useState(pov.section_texts || {});
  const [sePrep, setSePrep] = useState(pov.se_prep_notes || '');
  const [regen, setRegen] = useState(null);   // { key, reason } modal state
  const [diff, setDiff] = useState(null);      // { key, old, new }
  const [revisions, setRevisions] = useState(null);
  const [showRevisions, setShowRevisions] = useState(false);
  const [agenda, setAgenda] = useState(null);
  const [status, setStatus] = useState(pov.status || 'Draft');
  const [winLoss, setWinLoss] = useState(pov.win_loss || '');
  const [winLossNote, setWinLossNote] = useState(pov.win_loss_note || '');
  const timers = useRef({});

  useEffect(() => { setSections(pov.section_texts || {}); setSePrep(pov.se_prep_notes || ''); }, [pov.id]);

  function editSection(key, text) {
    setSections(s => ({ ...s, [key]: text }));
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      api.updatePovSection(accountId, pov.id, key, { text, reason: 'inline edit' }).catch(() => {});
    }, 2000);
  }

  async function doRegenerate() {
    const { key, reason } = regen;
    setRegen(null);
    try {
      const res = await api.regeneratePovSection(accountId, pov.id, key, { reason, existing_sections: sections });
      setDiff({ key, old: res.old_text, new: res.new_text });
    } catch (e) { toast(e.message, 'error'); }
  }
  function acceptDiff() { setSections(s => ({ ...s, [diff.key]: diff.new })); setDiff(null); }
  async function keepOriginal() {
    await api.updatePovSection(accountId, pov.id, diff.key, { text: diff.old, reason: 'kept original after regenerate' }).catch(() => {});
    setSections(s => ({ ...s, [diff.key]: diff.old }));
    setDiff(null);
  }

  async function saveSePrep() { await api.updatePov(accountId, pov.id, { se_prep_notes: sePrep }).catch(() => {}); toast('SE prep notes saved', 'success'); }

  async function saveStatus(next) {
    setStatus(next);
    const body = { status: next };
    if (next === 'Closed') { body.win_loss = winLoss || null; body.win_loss_note = winLossNote || null; }
    const updated = await api.updatePov(accountId, pov.id, body).catch(() => null);
    if (updated) setPov(updated);
  }

  async function loadRevisions() {
    setShowRevisions(s => !s);
    if (!revisions) setRevisions(await api.povRevisions(pov.id).catch(() => []));
  }

  async function makeAgenda() {
    try {
      const text = await generateKickoffAgenda(`Create a 45-minute POV kickoff agenda for ${account.account_name}. POV summary:\n${(sections['SECTION 1: Purpose'] || pov.pov_text || '').slice(0, 1500)}`);
      setAgenda(text);
    } catch (e) { toast(e.message, 'error'); }
  }

  const lowConf = pov.low_confidence_sections || [];

  return (
    <div className="p-6 max-w-6xl mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={() => navigate(`/accounts/${accountId}`)} className="text-text-dim hover:text-text-primary"><Icon.Back width={16} height={16} /></button>
          <h1 className="text-[15px] font-semibold text-text-primary truncate">POV {version ? `v${version}` : `#${pov.id}`} — {account.account_name}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select value={status} onChange={e => saveStatus(e.target.value)} className="bg-card border border-border rounded px-2 py-1.5 text-[11px] text-text-primary">
            {POV_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
          <button onClick={onEditInputs} title="Review or change product selections, duration, and timeline" className="flex items-center gap-1 bg-card border border-border rounded px-2.5 py-1.5 text-[11px] text-text-primary hover:border-accent-blue/40"><Icon.Edit width={12} height={12} /> Edit inputs</button>
          <button onClick={makeAgenda} disabled={!online} className="bg-card border border-border rounded px-2.5 py-1.5 text-[11px] text-text-primary hover:border-accent-blue/40 disabled:opacity-40">Kickoff agenda</button>
          <button onClick={onExport} className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-2.5 py-1.5 text-[11px] font-medium hover:bg-accent-blue/25">Export</button>
        </div>
      </div>

      {status === 'Closed' && (
        <div className="bg-card border border-border rounded-lg p-3 flex items-center gap-3">
          <span className="text-[11px] text-text-muted">Outcome:</span>
          <select value={winLoss} onChange={e => { setWinLoss(e.target.value); }} className="bg-[#040d1c] border border-border rounded px-2 py-1 text-[11px] text-text-primary">
            <option value="">—</option><option value="win">Win</option><option value="loss">Loss</option>
          </select>
          <input value={winLossNote} onChange={e => setWinLossNote(e.target.value)} placeholder="Win/loss note" className="flex-1 bg-[#040d1c] border border-border rounded px-2 py-1 text-[11px] text-text-primary" />
          <button onClick={() => saveStatus('Closed')} className="text-[11px] text-accent-blue hover:underline">Save outcome</button>
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 240px' }}>
        {/* sections */}
        <div className="flex flex-col gap-3">
          {Object.entries(sections).map(([key, text]) => {
            const low = lowConf.some(p => key.toLowerCase().includes(String(p).toLowerCase()));
            return (
              <div key={key} className="bg-card border border-border rounded-lg">
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <span className="text-[12px] font-medium text-text-primary">{key}</span>
                  <div className="flex items-center gap-2">
                    {low && <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#2e1d18] text-accent-yellow">Limited docs — verify</span>}
                    <button onClick={() => setRegen({ key, reason: '' })} disabled={!online} className="text-[10px] text-accent-blue hover:underline disabled:opacity-40">Regenerate</button>
                  </div>
                </div>
                {diff && diff.key === key ? (
                  <div className="p-3 flex flex-col gap-2">
                    <div className="text-[11px] text-accent-red whitespace-pre-wrap line-through opacity-70 border border-[#290b17] rounded p-2 bg-[#290b17]">{diff.old}</div>
                    <div className="text-[11px] text-accent-green whitespace-pre-wrap border border-[#032417] rounded p-2 bg-[#032417]">{diff.new}</div>
                    <div className="flex justify-end gap-2">
                      <button onClick={keepOriginal} className="text-[11px] text-text-muted hover:text-text-primary">Keep original</button>
                      <button onClick={acceptDiff} className="text-[11px] text-accent-green hover:underline">Accept</button>
                    </div>
                  </div>
                ) : (
                  <div className="px-3 py-2">
                    <EditableMarkdown
                      value={text}
                      onChange={v => editSection(key, v)}
                      placeholder="Empty section"
                      className="text-[11px] text-text-secondary"
                      textareaClassName="w-full bg-transparent text-[11px] text-text-secondary leading-relaxed focus:outline-none resize-y whitespace-pre-wrap"
                    />
                  </div>
                )}
              </div>
            );
          })}

          {/* SE prep notes (collapsible-ish, always shown) */}
          <div className="bg-card border border-border rounded-lg">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-[12px] font-medium text-text-primary flex items-center gap-1.5">🔒 SE prep notes <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#2e1d18] text-accent-yellow">Private — not included in export</span></span>
              <button onClick={saveSePrep} className="text-[10px] text-accent-blue hover:underline">Save</button>
            </div>
            <textarea value={sePrep} onChange={e => setSePrep(e.target.value)} className="w-full bg-transparent px-3 py-2 text-[11px] text-text-secondary leading-relaxed focus:outline-none resize-y" style={{ minHeight: 120 }} />
          </div>

          {/* Revision history */}
          <div className="bg-card border border-border rounded-lg">
            <button onClick={loadRevisions} className="w-full flex items-center justify-between px-3 py-2 text-[12px] text-text-primary">
              Revision history <span className="text-text-dim">{showRevisions ? '▾' : '▸'}</span>
            </button>
            {showRevisions && (
              <div className="p-3 flex flex-col gap-1.5">
                {(revisions || []).length === 0 && <div className="text-[10px] text-text-dim">No revisions.</div>}
                {(revisions || []).map(r => (
                  <div key={r.id} className="border border-border rounded px-2 py-1.5 text-[10px]">
                    <div className="flex items-center gap-2"><span className="text-text-primary">{r.section_key}</span><span className="text-text-dim">{r.change_type}</span><span className="text-text-dim ml-auto">{formatDate(r.changed_at)}</span></div>
                    {r.reason && <div className="text-text-muted mt-0.5">{r.reason}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* sources panel */}
        <div className="flex flex-col gap-3">
          <div className="bg-card border border-border rounded-lg p-3">
            <div className="text-[11px] font-medium text-text-primary mb-2">Sources ({(pov.sources || []).length})</div>
            <div className="flex flex-col gap-1">
              {(pov.sources || []).length === 0 && <div className="text-[10px] text-text-dim">No documentation sources.</div>}
              {(pov.sources || []).map((u, i) => <a key={i} href={u} target="_blank" rel="noreferrer" className="text-[10px] text-accent-blue hover:underline truncate">{u}</a>)}
            </div>
          </div>
          <div className="bg-[#111f42] border border-border rounded-lg p-3 text-[10px] text-text-muted">
            Generated {formatDate(pov.generated_at)} · {pov.chunks_used || 0} doc chunks · {pov.model_used || 'sonnet'}
          </div>
        </div>
      </div>

      {regen && (
        <Modal title={`Regenerate "${regen.key}"`} onClose={() => setRegen(null)} width="max-w-md"
          footer={<><button onClick={() => setRegen(null)} className="text-[12px] text-text-muted">Cancel</button><button onClick={doRegenerate} className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium">Regenerate</button></>}>
          <textarea value={regen.reason} onChange={e => setRegen(r => ({ ...r, reason: e.target.value }))} placeholder="Why regenerate? (optional context for the model)" rows={4} className={inputCls} />
        </Modal>
      )}
      {agenda && (
        <Modal title="Kickoff agenda (45 min)" onClose={() => setAgenda(null)} width="max-w-lg"
          footer={<><button onClick={() => { navigator.clipboard?.writeText(agenda); toast('Copied', 'success'); }} className="text-[12px] text-accent-blue">Copy</button><button onClick={() => { window.location.href = `mailto:?subject=${encodeURIComponent('POV Kickoff Agenda')}&body=${encodeURIComponent(agenda)}`; }} className="text-[12px] text-text-muted">Add to invite</button></>}>
          <Markdown className="text-[11px] text-text-secondary">{agenda}</Markdown>
        </Modal>
      )}
      {exportOpen && <ExportModal accountId={accountId} accountName={account.account_name} account={account} pov={pov} onClose={onCloseExport} />}
    </div>
  );
}
