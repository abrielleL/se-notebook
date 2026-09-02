import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import DatePicker from 'react-datepicker';
import { api } from '../lib/api.js';
import Icon from '../components/Icons.jsx';
import Modal from '../components/Modal.jsx';
import AccountExportModal from '../components/AccountExportModal.jsx';
import AccountFiles from '../components/AccountFiles.jsx';
import StageGateModal from '../components/StageGateModal.jsx';
import FieldDrawer from '../components/FieldDrawer.jsx';
import Markdown, { stripMarkdown } from '../components/Markdown.jsx';
import AccountTagEditor from '../components/AccountTagEditor.jsx';
import ContactDrawer, { ContactTypeBadge } from '../components/ContactDrawer.jsx';
import { useToast } from '../components/Toast.jsx';
import { useOnline } from '../lib/offline.jsx';
import { usePovJob } from '../lib/povJob.js';
import { emitAccountUpdated } from '../lib/accountStore.js';
import { runFullExtraction, generateCRMSnapshot, CRM_SNAPSHOT_MAX } from '../lib/ai.js';
import { formatDate, initials, todayISO, parseISODate, toISODate } from '../lib/stage.js';
import { linkedInSearchUrl } from '../lib/linkedin.js';
import {
  riskDot, RISK_OPTIONS, escalationStyle, ESCALATION_OPTIONS, QUAL_FIELDS,
  ROLE_BADGES, ROLE_OPTIONS, STAGE_BAR, EXTRA_STAGES, STAGE_GATES, nextStage, stageBarStyle,
  agingColor, PRESALES_STAGES, CONTACT_TYPE_OPTIONS, ACCOUNT_TYPES, ACCOUNT_TYPE_TABS, accountType
} from '../lib/constants.js';

// Accent color for a terminal stage when it is the account's current stage.
const EXTRA_STAGE_COLOR = { 'Not Required': '#838892', 'Stalled': '#ff9a4d', 'Canceled': '#ff6b66' };

// Build the post-save toast, including extracted/updated contacts (STEP 5).
function extractionMessage(prefix, r) {
  if (!r) return `${prefix}. AI extraction failed.`;
  const parts = [prefix];
  if (r.fieldsUpdated.length) parts.push(`${r.fieldsUpdated.length} field${r.fieldsUpdated.length > 1 ? 's' : ''} updated`);
  const created = (r.contacts || []).filter(c => c.created).length;
  const updated = (r.contacts || []).filter(c => !c.created).length;
  if (created) parts.push(`${created} contact${created > 1 ? 's' : ''} extracted`);
  else if (updated) parts.push(`${updated} contact${updated > 1 ? 's' : ''} updated`);
  if (!r.hasKey) parts.push('AI summary skipped — no API key set (add it in Settings)');
  else if (r.summaryError) parts.push(`AI summary failed: ${r.summaryError}`);
  return parts.join(' · ');
}

// Success only when the AI summary actually ran; otherwise warn so a swallowed
// summary failure no longer reads as a green "success" toast.
const extractionSeverity = (r) => (r && r.hasKey && !r.summaryError) ? 'success' : 'warn';

function splitHistory(value) {
  if (!value) return [];
  const segs = value.split(/\n\n(?=\[[A-Z][a-z]{2} \d)/);
  return segs.map((s, i) => {
    const m = s.match(/^\[([A-Z][a-z]{2} \d{1,2}, \d{4})\]\s*([\s\S]*)$/);
    if (m) return { when: m[1], what: m[2].slice(0, 120) };
    return { when: i === 0 ? 'original' : '', what: s.slice(0, 120) };
  });
}

function Section({ title, right, children, icon: IconCmp }) {
  return (
    <div className="bg-card border border-border rounded-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          {IconCmp && <IconCmp width={13} height={13} className="text-text-muted shrink-0" />}
          <span className="text-[11px] font-medium text-text-primary truncate">{title}</span>
        </div>
        {right}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

export default function AccountDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const online = useOnline();

  const [account, setAccount] = useState(null);
  const [di, setDi] = useState({});
  const [povs, setPovs] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);

  const [drawer, setDrawer] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [gateTarget, setGateTarget] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [tagCatalog, setTagCatalog] = useState([]);
  useEffect(() => { api.listTags().then(setTagCatalog).catch(() => {}); }, []);

  const [noteText, setNoteText] = useState('');
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const activePov = povs[0] || null;

  // Most recent transcript upload, for the history header. The API already
  // orders transcripts newest-first, but this reduces over created_at rather
  // than trusting position, so it stays correct if that ordering ever changes
  // (it sorts by call_date first, which can differ from upload order).
  const lastTranscriptUpload = useMemo(() => {
    const dates = (account?.transcripts || []).map(t => t.created_at).filter(Boolean);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [account]);

  // Persistent indicator for a background POV job started elsewhere — resumes
  // from localStorage so it stays visible after navigating away and back.
  const { generating: povGenerating } = usePovJob(id, {
    onComplete: () => { loadAll(); toast('POV generated', 'success'); },
    onError: (msg) => toast(`POV generation failed: ${msg}`, 'warn')
  });

  async function loadAll() {
    const [acct, dealIntel, povList, snaps] = await Promise.all([
      api.getAccount(id),
      api.getDealIntelligence(id).catch(() => ({})),
      api.listPov(id).catch(() => []),
      api.listCrmSnapshots(id).catch(() => [])
    ]);
    setAccount(acct); setDi(dealIntel); setPovs(povList); setSnapshots(snaps);
    setLoading(false);
  }
  useEffect(() => { setLoading(true); loadAll(); }, [id]);

  // Catch-up pass for notes flagged pending_ai_extraction=1 -- either saved
  // while offline, or saved by a path that failed to extract at the time. The
  // server only clears the flag once a key was actually present, so this keeps
  // retrying until the extraction really runs.
  const pendingRan = useRef(false);
  useEffect(() => {
    if (!online || !account) return;
    const pending = (account.notes || []).filter(n => n.pending_ai_extraction);
    if (!pending.length || pendingRan.current) return;
    pendingRan.current = true;
    runFullExtraction(id, pending[pending.length - 1].id)
      .then(r => {
        loadAll();
        // Report what actually happened rather than assuming it worked; a
        // missing key leaves the qualification fields empty and says so.
        toast(extractionMessage('Caught up on unprocessed notes', r), extractionSeverity(r));
      })
      .catch(() => toast('Could not process unextracted notes.', 'warn'))
      .finally(() => { pendingRan.current = false; });
  }, [online, account, id]);

  async function patchAccount(body) {
    try {
      const updated = await api.updateAccount(id, body);
      setAccount(a => ({ ...a, ...updated }));   // detail topbar + info card update
      emitAccountUpdated(updated);                // accounts list / dashboard update live
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }

  async function advanceStage(stage) {
    setGateTarget(null);
    await patchAccount({ presales_stage: stage });
    toast(`Stage set to ${stage}`, 'success');
  }

  async function saveNote() {
    if (!noteText.trim()) {
      toast('Please add some notes before saving.', 'warn');
      return;
    }
    const raw = noteText;
    try {
      const note = await api.createNote({ account_id: id, date: todayISO(), raw_notes: raw, pending_ai_extraction: online ? 0 : 1 });
      setNoteText('');
      if (online) {
        setExtracting(true);
        const r = await runFullExtraction(id, note.id).catch(() => null);
        setExtracting(false);
        await loadAll();
        toast(extractionMessage('Note saved', r), extractionSeverity(r));
      } else { await loadAll(); toast('Note saved offline. Extraction will run when reconnected.', 'warn'); }
    } catch (e) { toast(`Save failed: ${e.message}`, 'error'); }
  }

  // Paste and file-drop both submit to the existing /api/transcripts route,
  // then trigger the same AI extraction pipeline as a note save.
  async function processTranscript({ text, file }) {
    const form = new FormData();
    form.append('account_id', id);
    form.append('source', file ? 'file_upload' : 'paste');
    if (file) {
      form.append('file', file);
    } else {
      if (!text || !text.trim()) return;
      form.append('content', text);
      form.append('title', 'Pasted transcript');
    }
    setExtracting(true);
    try {
      const t = await api.uploadTranscript(form);
      setTranscriptOpen(false);
      if (online) {
        const r = await runFullExtraction(id, null, t && t.id).catch(() => null);
        await loadAll();
        toast(extractionMessage('Transcript processed', r), extractionSeverity(r));
      } else {
        await loadAll();
        toast('Transcript saved offline. Run AI extract when reconnected.', 'warn');
      }
    } catch (e) {
      toast(`Transcript failed: ${e.message}`, 'error');
    } finally {
      setExtracting(false);
    }
  }

  function openFieldDrawer({ title, value, footNote, save }) {
    setDrawer({ title, value, history: splitHistory(value), footNote, save });
  }

  if (loading || !account) return <div className="p-8 text-[12px] text-text-muted">Loading account…</div>;

  return (
    <div className="flex flex-col h-full">
      {/* TOPBAR */}
      <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <button onClick={() => navigate('/accounts')} className="text-text-dim hover:text-text-primary"><Icon.Back width={16} height={16} /></button>
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: riskDot(account.risk) }} />
            <span className="text-[15px] font-semibold text-text-primary truncate">{account.account_name}</span>
            {accountType(account) === 'partner' && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0"
                style={{ color: ACCOUNT_TYPES.partner.color, background: `${ACCOUNT_TYPES.partner.color}1f`, border: `1px solid ${ACCOUNT_TYPES.partner.color}59` }}>
                Partner
              </span>
            )}
            {account.presales_stage && <span className="text-[10px] px-2 py-0.5 rounded bg-[#0c295f] text-accent-blue shrink-0">{account.presales_stage}</span>}
            {account.escalation && account.escalation !== 'Not Needed' && (
              <span className="text-[10px] px-2 py-0.5 rounded shrink-0" style={{ background: escalationStyle(account.escalation).bg, color: escalationStyle(account.escalation).text }}>{account.escalation}</span>
            )}
          </div>
          <div className="text-[11px] text-text-muted mt-1 flex flex-wrap items-center gap-x-2">
            <span>{account.ae_name || account.account_executive || 'No AE'}</span>
            <span className="text-text-dim">·</span><span>{account.industry || 'No industry'}</span>
            {account.opportunity_value != null && <><span className="text-text-dim">·</span><span>${Number(account.opportunity_value).toLocaleString()}</span></>}
            {account.close_date && <><span className="text-text-dim">·</span><span>close {formatDate(account.close_date)}</span></>}
          </div>
          <div className="mt-2">
            <AccountTagEditor tags={account.tags || []} catalog={tagCatalog} onChange={(tags) => patchAccount({ tags })} />
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setExportOpen(true)} className="flex items-center gap-1.5 bg-card border border-border rounded px-3 py-1.5 text-[12px] text-text-primary hover:border-accent-blue/40"><Icon.Export width={12} height={12} /> Export</button>
          <button onClick={() => setEditOpen(true)} className="flex items-center gap-1.5 bg-card border border-border rounded px-3 py-1.5 text-[12px] text-text-primary hover:border-accent-blue/40"><Icon.Edit width={12} height={12} /> Edit</button>
        </div>
      </div>

      {/* STAGE BAR */}
      <div className="px-5 py-2 border-b border-border flex items-center gap-1 overflow-x-auto">
        {STAGE_BAR.map(stage => {
          const st = stageBarStyle(stage, account.presales_stage);
          return (
            <button key={stage} onClick={() => stage === account.presales_stage ? null : setGateTarget(stage)}
              className="text-[10px] px-2.5 py-1 rounded whitespace-nowrap transition hover:opacity-80"
              style={{ background: st.bg, color: st.text }}>
              {stage}
            </button>
          );
        })}
        <span className="w-px h-5 bg-border mx-1 shrink-0" />
        {EXTRA_STAGES.map(stage => {
          const isCurrent = account.presales_stage === stage;
          const color = EXTRA_STAGE_COLOR[stage] || '#838892';
          return (
            <button key={stage} onClick={() => isCurrent ? null : setGateTarget(stage)}
              className="text-[10px] px-2.5 py-1 rounded whitespace-nowrap border transition hover:opacity-80"
              style={isCurrent
                ? { background: `${color}26`, color: color, borderColor: `${color}88` }
                : { background: 'transparent', color: '#838892', borderColor: '#273454' }}>
              {stage}
            </button>
          );
        })}
      </div>

      {/* THREE COLUMNS */}
      <div className="flex-1 overflow-auto p-3">
        <div className="grid gap-3" style={{ gridTemplateColumns: '220px 1fr 240px' }}>
          {/* LEFT */}
          <div className="flex flex-col gap-3 min-w-0">
            <Section title="Account info" icon={Icon.Folder} right={<button onClick={() => setEditOpen(true)} className="text-text-dim hover:text-accent-blue"><Icon.Edit width={12} height={12} /></button>}>
              <div className="flex flex-col gap-1.5 text-[11px]">
                <Row label="Industry" value={account.industry} />
                <Row label="AE" value={account.ae_name || account.account_executive} />
                <Row label="Close date" value={account.close_date && formatDate(account.close_date)} />
                <Row label="Value" value={account.opportunity_value != null ? `$${Number(account.opportunity_value).toLocaleString()}` : null} />
                <div className="flex justify-between gap-2">
                  <span className="text-text-dim">Risk</span>
                  <span className="flex items-center gap-1.5 text-text-secondary">
                    <span className="w-2 h-2 rounded-full" style={{ background: riskDot(account.risk) }} />
                    {RISK_OPTIONS.find(r => r.value === account.risk)?.label || '—'}
                  </span>
                </div>
                {account.pov_success_plan_url && <a href={account.pov_success_plan_url} target="_blank" rel="noreferrer" className="text-accent-blue hover:underline truncate">POV success plan ↗</a>}
                {account.jira_ticket_url && <a href={account.jira_ticket_url} target="_blank" rel="noreferrer" className="text-accent-blue hover:underline truncate">Jira ticket ↗</a>}
              </div>
            </Section>

            <ContactsCard account={account} onChange={loadAll} />
            <StageGateCard account={account} onAdvance={(s) => setGateTarget(s)} />

            <CrmSnapshotCard account={account} snapshot={snapshots[0]} onChange={loadAll} />

            <ActivePovCard povs={povs} accountId={id} navigate={navigate} generating={povGenerating} onChange={loadAll} />
          </div>

          {/* CENTER */}
          <div className="flex flex-col gap-3 min-w-0">
            <Section title="AI summary" icon={Icon.Sparkles}
              right={account.ai_summary_updated_at && <span className="text-[10px] text-text-dim">{formatDate(account.ai_summary_updated_at)}</span>}>
              <div className="text-[11px] text-text-secondary mb-3 max-h-32 overflow-hidden">
                {account.ai_summary ? <Markdown>{account.ai_summary}</Markdown> : <span className="text-text-dim">No summary yet.</span>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Pane title="Technical drivers" value={account.ai_technical_drivers}
                  onExpand={() => openFieldDrawer({ title: 'Technical drivers', value: account.ai_technical_drivers, footNote: 'AI extracted', save: (t) => patchAccount({ ai_technical_drivers: t }) })} />
                <Pane title="Environment" value={account.ai_environment}
                  onExpand={() => openFieldDrawer({ title: 'Environment', value: account.ai_environment, footNote: 'AI extracted', save: (t) => patchAccount({ ai_environment: t }) })} />
              </div>
            </Section>

            <Section title="Account qualification" icon={Icon.Check}>
              <div className="grid grid-cols-2 gap-2">
                {QUAL_FIELDS.map(f => {
                  const entry = di[f.key] || { value: '' };
                  const has = !!(entry.value && entry.value.trim());
                  return (
                    <button key={f.key} onClick={() => openFieldDrawer({
                      title: f.label, value: entry.value, footNote: 'AI extracted · merges on note save',
                      save: (t) => api.updateDealIntelligence(id, f.key, { value: t, mode: 'replace' }).then(() => loadAll())
                    })} className="text-left border border-border rounded p-2 hover:border-accent-blue/40 transition">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: has ? '#4fd15c' : '#ff6b66' }} />
                        <span className="text-[10px] font-medium text-text-primary">{f.label}</span>
                      </div>
                      <div className="text-[10px] text-text-muted leading-snug overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {has ? stripMarkdown(entry.value) : <span className="text-text-dim">Empty</span>}
                      </div>
                      {has && entry.last_updated && <div className="text-[9px] text-text-dim mt-1">AI extracted · {formatDate(entry.last_updated)}</div>}
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section title="New note" icon={Icon.Note}>
              <div className="flex items-center gap-2 mb-2 text-[11px]">
                <span className="text-text-dim">Date: {todayISO()}</span>
              </div>
              <textarea
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                rows={20}
                placeholder="Type or paste your notes…"
                className="w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[11px] text-text-primary placeholder-text-dim font-mono leading-relaxed focus:outline-none focus:border-accent-blue/50 resize-y"
              />
              <div className="flex justify-end gap-2 mt-2">
                <button onClick={() => setTranscriptOpen(true)}
                  className="bg-card border border-border rounded px-3 py-1.5 text-[12px] text-text-primary hover:border-accent-blue/40">
                  Paste transcript
                </button>
                <button onClick={saveNote} disabled={extracting}
                  className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium hover:bg-accent-blue/25 disabled:opacity-50">
                  {extracting ? 'Extracting deal intelligence…' : 'Save + AI extract'}
                </button>
              </div>
            </Section>

            <TranscriptDropZone onFile={(file) => processTranscript({ file })} busy={extracting} />

            <Section title={`Note history (${(account.notes || []).length})`} icon={Icon.Note}>
              <div className="flex flex-col gap-2">
                {(account.notes || []).length === 0 && <div className="text-[11px] text-text-dim">No notes yet.</div>}
                {(account.notes || []).map(n => <NoteRow key={n.id} note={n} />)}
              </div>
            </Section>

            <Section
              title={`Transcript history (${(account.transcripts || []).length})`}
              icon={Icon.Mic}
              right={lastTranscriptUpload && (
                <span className="text-[10px] text-text-dim shrink-0">Last upload · {formatDate(lastTranscriptUpload)}</span>
              )}
            >
              <div className="flex flex-col gap-2">
                {(account.transcripts || []).length === 0 && <div className="text-[11px] text-text-dim">No transcripts yet.</div>}
                {(account.transcripts || []).map(t => <TranscriptRow key={t.id} transcript={t} />)}
              </div>
            </Section>

            <AccountFiles accountId={id} />
          </div>

          {/* RIGHT */}
          <div className="flex flex-col gap-3 min-w-0">
            <NextStepsCard account={account} onChange={loadAll} />
            <PrereqCard pov={activePov} />
          </div>
        </div>
      </div>

      {drawer && <FieldDrawer title={drawer.title} value={drawer.value} history={drawer.history} footNote={drawer.footNote}
        onSave={async (t) => { await drawer.save(t); }} onClose={() => setDrawer(null)} />}
      {exportOpen && <AccountExportModal accountId={id} accountName={account.account_name} account={account} di={di} snapshot={snapshots[0]} pov={activePov} onClose={() => setExportOpen(false)} />}
      {gateTarget && <StageGateModal accountId={id} targetStage={gateTarget} onAdvance={advanceStage} onClose={() => setGateTarget(null)} />}
      {editOpen && <EditAccountModal account={account} onClose={() => setEditOpen(false)} onSave={async (b) => { const ok = await patchAccount(b); if (ok) setEditOpen(false); }} />}
      {transcriptOpen && <TranscriptModal onClose={() => setTranscriptOpen(false)} onSave={(t) => processTranscript({ text: t })} />}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-text-dim">{label}</span>
      <span className="text-text-secondary text-right truncate">{value || '—'}</span>
    </div>
  );
}

function Pane({ title, value, onExpand }) {
  return (
    <div className="border border-border rounded p-2 bg-[#040d1c] group relative">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-medium text-text-muted">{title}</span>
        <button onClick={onExpand} className="text-text-dim hover:text-accent-blue opacity-0 group-hover:opacity-100"><Icon.Eye width={12} height={12} /></button>
      </div>
      <div className="text-[10px] text-text-secondary leading-snug overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>
        {value ? stripMarkdown(value) : <span className="text-text-dim">—</span>}
      </div>
    </div>
  );
}

function NoteRow({ note }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-[#111f42] text-left">
        <span className="text-[11px] text-text-primary">{formatDate(note.date)}</span>
        {note.note_type && <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#0c295f] text-accent-blue">{note.note_type}</span>}
        <span className="ml-auto text-text-dim text-[10px]">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="px-2.5 py-2 text-[11px] text-text-secondary whitespace-pre-wrap leading-relaxed">{note.raw_notes || <span className="text-text-dim">empty</span>}</div>}
    </div>
  );
}

// Where a transcript came from, in plain words.
const TRANSCRIPT_SOURCES = {
  file_upload: 'File',
  clari_copilot: 'Clari',
  paste: 'Pasted'
};

function TranscriptRow({ transcript: t }) {
  const [open, setOpen] = useState(false);
  const uploaded = (t.created_at || '').slice(0, 10);
  // The call date is the useful one; surface the upload date only when it
  // differs, since for a file upload the two are usually the same day.
  const showUploaded = uploaded && t.call_date && uploaded !== t.call_date;
  return (
    <div className="border border-border rounded">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-[#111f42] text-left">
        <span className="text-[11px] text-text-primary shrink-0">{formatDate(t.call_date || t.created_at)}</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#0c295f] text-accent-blue shrink-0">
          {TRANSCRIPT_SOURCES[t.source] || t.source || 'Transcript'}
        </span>
        {t.title && <span className="text-[10px] text-text-muted truncate min-w-0">{t.title}</span>}
        <span className="ml-auto text-text-dim text-[10px] shrink-0">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-2.5 py-2">
          <div className="text-[9px] text-text-dim mb-1.5">
            {showUploaded ? `Uploaded ${formatDate(t.created_at)} · ` : ''}
            {t.duration_minutes ? `${t.duration_minutes} min · ` : ''}
            {(t.content || '').length.toLocaleString()} characters
          </div>
          {/* Transcripts run tens of thousands of characters, so unlike a note
              this is capped and scrolled rather than expanded inline. */}
          <div className="text-[11px] text-text-secondary whitespace-pre-wrap leading-relaxed font-mono overflow-y-auto border border-border-inset rounded bg-[#040d1c] px-2 py-1.5" style={{ maxHeight: 280 }}>
            {t.content || <span className="text-text-dim">empty</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const CONTACT_INPUT = 'bg-[#040d1c] border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/50 w-full';
const emptyContactForm = () => ({
  name: '', title: '', org_name: '', email: '', phone: '',
  contact_type: 'customer', meddpicc_role: '', linkedin_url: ''
});

function ContactFields({ form, setForm }) {
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <>
      <div className="flex gap-1.5">
        <input placeholder="Name" value={form.name} onChange={set('name')} className={CONTACT_INPUT} />
        <input placeholder="Title" value={form.title} onChange={set('title')} className={CONTACT_INPUT} />
      </div>
      <div className="flex gap-1.5">
        <select value={form.contact_type} onChange={set('contact_type')} className={CONTACT_INPUT}>
          {CONTACT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input
          placeholder={form.contact_type === 'customer' ? 'Organization (optional)' : 'Their employer'}
          value={form.org_name} onChange={set('org_name')} className={CONTACT_INPUT}
        />
      </div>
      <div className="flex gap-1.5">
        <input placeholder="Email" value={form.email} onChange={set('email')} className={CONTACT_INPUT} />
        <input placeholder="Phone" value={form.phone} onChange={set('phone')} className={CONTACT_INPUT} />
      </div>
      <input placeholder="LinkedIn URL (optional)" value={form.linkedin_url} onChange={set('linkedin_url')} className={CONTACT_INPUT} />
      <select value={form.meddpicc_role} onChange={set('meddpicc_role')} className={CONTACT_INPUT}>
        {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
    </>
  );
}

// Attach someone who already exists in the directory. This is how a partner
// ends up on a second account without being retyped as a new person.
function LinkExistingContact({ account, onDone, onCancel }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [role, setRole] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      api.listContacts({ q, sort: 'name' })
        .then(rows => setResults(rows.filter(r => !r.account_ids.includes(account.id)).slice(0, 8)))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(t);
  }, [query, account.id]);

  async function link(c) {
    try {
      await api.linkContactAccount(c.id, { account_id: account.id, role: role || null });
      toast(`${c.name} linked to ${account.account_name}`, 'success');
      onDone();
    } catch (e) {
      toast(e.message || 'Link failed', 'error');
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border border-accent-blue/30 rounded p-2 bg-[#111f42]">
      <div className="text-[10px] text-text-muted">Link someone already in the directory</div>
      <input
        autoFocus
        placeholder="Search name, title, or organization"
        value={query}
        onChange={e => setQuery(e.target.value)}
        className={CONTACT_INPUT}
      />
      <select value={role} onChange={e => setRole(e.target.value)} className={CONTACT_INPUT}>
        {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <div className="flex flex-col gap-1">
        {results.map(c => (
          <button
            key={c.id}
            onClick={() => link(c)}
            className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[#111f42] text-left"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] text-text-primary truncate">{c.name}</span>
              <span className="block text-[9px] text-text-dim truncate">
                {c.title || 'no title'}{c.org_name ? ` · ${c.org_name}` : ''}
                {c.account_count ? ` · on ${c.account_count} account${c.account_count === 1 ? '' : 's'}` : ''}
              </span>
            </span>
            <Icon.Link width={10} height={10} className="text-accent-blue shrink-0" />
          </button>
        ))}
        {query.trim().length >= 2 && !searching && results.length === 0 && (
          <div className="text-[10px] text-text-dim">No match. Use + to add a new person.</div>
        )}
      </div>
      <div className="flex justify-end">
        <button onClick={onCancel} className="text-[10px] text-text-muted hover:text-text-primary">Cancel</button>
      </div>
    </div>
  );
}

function ContactsCard({ account, onChange }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const [addForm, setAddForm] = useState(emptyContactForm());
  const [openId, setOpenId] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const [allAccounts, setAllAccounts] = useState([]);

  // Only needed by the drawer's "link to another account" picker.
  useEffect(() => {
    if (openId) api.listAccounts().then(setAllAccounts).catch(() => setAllAccounts([]));
  }, [openId]);

  function openAdd() {
    setLinking(false);
    setAddForm(emptyContactForm());
    setAdding(true);
  }

  async function add() {
    if (!addForm.name.trim()) return;
    try {
      const created = await api.createContact({
        account_id: account.id,
        ...addForm,
        meddpicc_role: addForm.meddpicc_role || null
      });
      setAddForm(emptyContactForm());
      setAdding(false);
      onChange();
      toast(
        created._merged_into_existing
          ? `${created.name} was already here — updated instead of duplicating`
          : 'Contact added',
        'success'
      );
    } catch (e) {
      toast(e.message || 'Could not add contact', 'error');
    }
  }

  // Removing from an account unlinks rather than deletes, so a partner shared
  // with other deals survives. Only their last link deletes the person.
  function doRemove(c) {
    setRemovingId(c.id);
    setTimeout(async () => {
      try {
        if ((c.account_count || 1) > 1) {
          await api.unlinkContactAccount(c.id, account.id);
          toast(`${c.name} unlinked from this account`, 'success');
        } else {
          await api.deleteContact(c.id);
          toast('Contact deleted', 'success');
        }
      } catch (e) {
        toast(e.message || 'Remove failed', 'error');
      }
      setRemovingId(null);
      setConfirmRemove(null);
      onChange();
    }, 220);
  }

  const contacts = account.contacts || [];
  return (
    <Section
      title="Contacts"
      icon={Icon.Users}
      right={
        <span className="flex items-center gap-1.5">
          <button onClick={() => { setAdding(false); setLinking(l => !l); }} className="text-text-dim hover:text-accent-blue" title="Link an existing contact">
            <Icon.Link width={11} height={11} />
          </button>
          <button onClick={openAdd} className="text-text-dim hover:text-accent-blue" title="Add a new contact">
            <Icon.Plus width={12} height={12} />
          </button>
        </span>
      }
    >
      <div className="flex flex-col gap-2">
        {contacts.map(c => {
          const badge = ROLE_BADGES[c.meddpicc_role];
          const shared = (c.account_count || 1) > 1;
          return (
            <div key={c.id}
              className="transition-opacity duration-200"
              style={{ opacity: removingId === c.id ? 0 : 1 }}>
              <div className="group flex items-start gap-2">
                <span className="w-6 h-6 rounded flex items-center justify-center text-[9px] font-semibold shrink-0 mt-0.5" style={{ background: '#0c295f', color: '#5c9bff' }}>{initials(c.name)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium text-text-primary truncate flex items-center gap-1">
                    {c.name}
                    {c.auto_extracted ? <Icon.Sparkles width={9} height={9} className="text-accent-purple" /> : null}
                    {c.contact_type && c.contact_type !== 'customer' && <ContactTypeBadge type={c.contact_type} />}
                  </div>
                  {c.title && <div className="text-[10px] text-text-dim truncate">{c.title}</div>}
                  {c.org_name && <div className="text-[10px] text-text-dim truncate">{c.org_name}</div>}
                  {c.email && <div className="text-[10px] text-text-dim truncate">{c.email}</div>}
                  {c.phone && <div className="text-[10px] text-text-dim truncate">{c.phone}</div>}
                  {shared && (
                    <Link to="/contacts" className="text-[9px] text-text-dim hover:text-accent-blue">
                      also on {c.account_count - 1} other account{c.account_count - 1 === 1 ? '' : 's'}
                    </Link>
                  )}
                  {confirmRemove === c.id && (
                    <div className="text-[10px] text-accent-red mt-1">
                      {shared ? 'Unlink' : 'Delete'} {c.name}?{' '}
                      <button onClick={() => doRemove(c)} className="underline">Yes</button>
                      {' / '}
                      <button onClick={() => setConfirmRemove(null)} className="underline">No</button>
                    </div>
                  )}
                </div>
                {badge && <span className="text-[9px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${badge.color}22`, color: badge.color }}>{badge.label}</span>}
                <a
                  href={c.linkedin_url || linkedInSearchUrl(c) || '#'}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={c.linkedin_url ? 'Open LinkedIn profile' : 'Search for them on LinkedIn'}
                  className={`shrink-0 transition ${
                    c.linkedin_url
                      ? 'text-accent-blue'
                      : 'text-text-dim hover:text-accent-blue opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <Icon.Link width={11} height={11} />
                </a>
                <button onClick={() => setOpenId(c.id)} className="text-text-dim hover:text-accent-blue shrink-0 opacity-0 group-hover:opacity-100 transition" title="Open contact">
                  <Icon.Edit width={11} height={11} />
                </button>
                <button onClick={() => setConfirmRemove(c.id)} className="text-text-dim hover:text-accent-red shrink-0 opacity-0 group-hover:opacity-100 transition" title={shared ? 'Unlink from this account' : 'Delete contact'}>
                  <Icon.X width={11} height={11} />
                </button>
              </div>
            </div>
          );
        })}

        {contacts.length === 0 && !adding && !linking && <div className="text-[10px] text-text-dim">No contacts.</div>}

        {linking && (
          <LinkExistingContact
            account={account}
            onDone={() => { setLinking(false); onChange(); }}
            onCancel={() => setLinking(false)}
          />
        )}

        {adding && (
          <div className="flex flex-col gap-1.5 border border-border rounded p-2">
            <ContactFields form={addForm} setForm={setAddForm} />
            <div className="flex justify-end gap-2">
              <button onClick={() => setAdding(false)} className="text-[10px] text-text-muted hover:text-text-primary">Cancel</button>
              <button onClick={add} className="text-[10px] text-accent-green hover:underline">Add</button>
            </div>
          </div>
        )}
      </div>

      {openId && (
        <ContactDrawer
          contactId={openId}
          accounts={allAccounts}
          onClose={() => setOpenId(null)}
          onChange={onChange}
        />
      )}
    </Section>
  );
}

function StageGateCard({ account, onAdvance }) {
  const stage = account.presales_stage;
  const gates = STAGE_GATES[stage] || [];
  const [state, setState] = useState({});
  useEffect(() => {
    if (stage) api.getStageGates(account.id, stage).then(r => setState(r.gates || {})).catch(() => {});
  }, [account.id, stage]);
  async function toggle(key) {
    const next = !(state[key] && state[key].completed);
    setState(s => ({ ...s, [key]: { completed: next } }));
    await api.updateStageGate(account.id, stage, key, next).catch(() => {});
  }
  const next = nextStage(stage);
  return (
    <Section title="Stage gates" icon={Icon.Check}>
      {account.escalation && account.escalation !== 'Not Needed' && (
        <div className="mb-2 text-[10px] px-2 py-1.5 rounded bg-[#2e1d18]/50 border border-[#5c3e2d] text-accent-yellow flex items-center justify-between gap-2">
          <span>⚠ {account.escalation}</span>
          {account.jira_ticket_url && <a href={account.jira_ticket_url} target="_blank" rel="noreferrer" className="underline shrink-0">Jira</a>}
        </div>
      )}
      {gates.length === 0 ? <div className="text-[10px] text-text-dim">No gates for this stage.</div> : (
        <div className="flex flex-col gap-1.5">
          {gates.map(g => {
            const done = state[g.key] && state[g.key].completed;
            return (
              <button key={g.key} onClick={() => toggle(g.key)} className="flex items-start gap-2 text-left">
                <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] shrink-0 mt-0.5 ${done ? 'bg-accent-green border-accent-green text-black' : 'border-text-dim'}`}>{done ? '✓' : ''}</span>
                <span className={`text-[10px] ${done ? 'text-text-secondary' : 'text-text-muted'}`}>{g.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {next && <button onClick={() => onAdvance(next)} className="w-full mt-2 text-[10px] py-1.5 rounded bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25">Advance to {next}</button>}
    </Section>
  );
}

function CrmSnapshotCard({ account, snapshot, onChange }) {
  const toast = useToast();
  const online = useOnline();
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = snapshot?.snapshot_text || '';

  async function generate() {
    setGenerating(true);
    try {
      await generateCRMSnapshot(account.id);
      await onChange();
      toast('Snapshot generated', 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setGenerating(false);
    }
  }
  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Copy failed — select and copy manually.', 'error');
    }
  }

  return (
    <Section title="CRM snapshot" icon={Icon.Sync}
      right={
        <button onClick={generate} disabled={generating || !online}
          title={!online ? 'AI features require internet connection' : 'Generate new snapshot'}
          className="flex items-center gap-1 text-[10px] text-accent-blue hover:underline disabled:opacity-40">
          {generating
            ? <span className="inline-block w-2.5 h-2.5 border border-accent-blue/40 border-t-accent-blue rounded-full animate-spin" />
            : <Icon.Refresh width={11} height={11} />}
          {generating ? 'Generating…' : 'Generate'}
        </button>
      }>
      <div className="text-[10px] text-text-dim mb-1.5">Stage: {account.presales_stage || '—'}</div>
      {text
        ? <Markdown className="text-[11px] text-text-secondary">{text}</Markdown>
        : <div className="text-[11px] text-text-dim">No snapshot yet. Generate one or save a note.</div>}
      {text && (
        <div className="flex items-center justify-between mt-2">
          <button onClick={copy}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-medium transition ${
              copied
                ? 'bg-accent-green/15 text-accent-green border-accent-green/30'
                : 'bg-card text-text-primary border-border hover:border-accent-blue/40 hover:text-accent-blue'
            }`}>
            {copied ? <Icon.Check width={12} height={12} /> : <Icon.Copy width={12} height={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <span className="text-[10px] text-text-dim">{text.length} / {CRM_SNAPSHOT_MAX}</span>
        </div>
      )}
    </Section>
  );
}

function ActivePovCard({ povs = [], accountId, navigate, generating, onChange }) {
  const toast = useToast();
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  // Version numbers by creation order (oldest = v1); display newest first.
  const versionOf = useMemo(() => {
    const m = {};
    [...povs].sort((a, b) => a.id - b.id).forEach((p, i) => { m[p.id] = i + 1; });
    return m;
  }, [povs]);
  const ordered = useMemo(() => [...povs].sort((a, b) => b.id - a.id), [povs]);

  async function del(pov) {
    setBusyId(pov.id);
    try {
      await api.deletePovDraft(pov.id);
      toast(`POV v${versionOf[pov.id]} deleted`, 'success');
      setConfirmId(null);
      await onChange();
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
    finally { setBusyId(null); }
  }

  return (
    <Section title={`POVs${povs.length ? ` (${povs.length})` : ''}`} icon={Icon.File}
      right={<button onClick={() => navigate(`/accounts/${accountId}/pov-generator`)} className="text-[10px] text-accent-blue hover:underline">+ New</button>}>
      {generating && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded bg-accent-blue/10 border border-accent-blue/30">
          <span className="inline-block w-2.5 h-2.5 border border-accent-blue/40 border-t-accent-blue rounded-full animate-spin" />
          <span className="text-[10px] text-accent-blue">POV generating…</span>
        </div>
      )}
      {ordered.length ? (
        <div className="flex flex-col gap-1.5">
          {ordered.map(p => (
            <div key={p.id} className="border border-border rounded px-2.5 py-2 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-text-primary flex-1 truncate">
                  POV v{versionOf[p.id]}{p.label ? ` · ${p.label}` : ''}
                </span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#0c295f] text-accent-blue shrink-0">{p.status || 'Draft'}</span>
              </div>
              <div className="text-[10px] text-text-dim">
                {p.start_date ? formatDate(p.start_date) : '—'} → {p.end_date ? formatDate(p.end_date) : '—'}
              </div>
              {confirmId === p.id ? (
                <div className="flex items-center gap-2 pt-0.5">
                  <span className="text-[10px] text-accent-red flex-1">Delete POV v{versionOf[p.id]}?</span>
                  <button onClick={() => del(p)} disabled={busyId === p.id} className="text-[10px] text-accent-red hover:underline disabled:opacity-40">{busyId === p.id ? 'Deleting…' : 'Yes'}</button>
                  <button onClick={() => setConfirmId(null)} className="text-[10px] text-text-muted hover:underline">No</button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button onClick={() => navigate(`/accounts/${accountId}/pov-generator/${p.id}`)} className="flex-1 text-[10px] py-1 rounded bg-card border border-border text-text-primary hover:border-accent-blue/40">Open</button>
                  <button onClick={() => setConfirmId(p.id)} title="Delete POV" className="text-text-dim hover:text-accent-red px-1.5"><Icon.Trash width={12} height={12} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="text-[10px] text-text-dim">No POV yet.</div>
          <button onClick={() => navigate(`/accounts/${accountId}/pov-generator`)} className="text-[10px] py-1.5 rounded bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25">Generate POV</button>
        </div>
      )}
    </Section>
  );
}

function NextStepsCard({ account, onChange }) {
  const [text, setText] = useState('');
  async function toggle(s) { await api.updateNextStep(s.id, { completed: !s.completed }); onChange(); }
  async function add() {
    if (!text.trim()) return;
    await api.createNextStep({ account_id: account.id, text, source: 'manual' });
    setText(''); onChange();
  }
  return (
    <Section title="Next steps" icon={Icon.Check}>
      <div className="flex flex-col gap-1.5">
        {(account.next_steps || []).map(s => (
          <div key={s.id} className="flex items-start gap-2">
            <button onClick={() => toggle(s)} className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${s.completed ? 'bg-accent-green border-accent-green' : 'border-text-dim'}`}>{s.completed && <Icon.Check width={9} height={9} className="text-black" />}</button>
            <div className={`text-[10px] flex-1 ${s.completed ? 'line-through text-text-dim' : 'text-text-secondary'}`}>{s.text} {s.source === 'ai' && <Icon.Sparkles width={8} height={8} className="inline text-accent-purple" />}</div>
          </div>
        ))}
        <div className="flex gap-1 mt-1">
          <input value={text} onChange={e => setText(e.target.value)} placeholder="Add step…" className="flex-1 bg-[#040d1c] border border-border rounded px-2 py-1 text-[10px] text-text-primary" />
          <button onClick={add} className="text-accent-blue px-1"><Icon.Plus width={12} height={12} /></button>
        </div>
      </div>
    </Section>
  );
}

function PrereqCard({ pov }) {
  const [checked, setChecked] = useState({});
  const items = useMemo(() => {
    const base = ['Network access to install host', 'Admin credentials available', 'License entitlement confirmed'];
    const text = pov ? JSON.stringify(pov.section_texts || {}).toLowerCase() : '';
    if (text.includes('air-gapped') || text.includes('air gapped') || text.includes('offline license')) {
      base.push('Offline license staged (air-gapped · 5 business day lead time)');
    }
    return base;
  }, [pov]);
  if (!pov) return <Section title="POV prerequisites" icon={Icon.Check}><div className="text-[10px] text-text-dim">No active POV.</div></Section>;
  return (
    <Section title="POV prerequisites" icon={Icon.Check}>
      <div className="flex flex-col gap-1.5">
        {items.map((it, i) => {
          const on = checked[i];
          const airgap = /air-gapped/.test(it);
          return (
            <button key={i} onClick={() => setChecked(c => ({ ...c, [i]: !c[i] }))} className="flex items-start gap-2 text-left">
              <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] shrink-0 mt-0.5 ${on ? 'bg-accent-green border-accent-green text-black' : airgap ? 'border-accent-red' : 'border-text-dim'}`}>{on ? '✓' : ''}</span>
              <span className={`text-[10px] ${on ? 'text-text-secondary' : airgap ? 'text-accent-red' : 'text-text-muted'}`}>{it}</span>
            </button>
          );
        })}
        {(pov.sources || []).slice(0, 2).map((u, i) => <a key={i} href={u} target="_blank" rel="noreferrer" className="text-[9px] text-accent-blue hover:underline truncate">{u}</a>)}
      </div>
    </Section>
  );
}

function buildAccountForm(account) {
  return {
    account_name: account.account_name || '',
    account_type: accountType(account),
    industry: account.industry || '',
    // Existing accounts store the AE in the legacy `account_executive` column;
    // fall back to it (same as the detail view) so the field pre-fills.
    ae_name: account.ae_name || account.account_executive || '',
    close_date: account.close_date || '',
    opportunity_value: account.opportunity_value ?? '',
    risk: account.risk || '',
    presales_stage: account.presales_stage || '',
    escalation: account.escalation || '',
    jira_ticket_url: account.jira_ticket_url || '',
    pov_success_plan_url: account.pov_success_plan_url || ''
  };
}

function EditAccountModal({ account, onClose, onSave }) {
  const [form, setForm] = useState(() => buildAccountForm(account));
  // Re-seed from the account if it changes (e.g. loads after mount or switches).
  useEffect(() => { setForm(buildAccountForm(account)); }, [account?.id]);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const inputCls = 'w-full bg-[#040d1c] border border-border rounded px-2 py-1.5 text-[12px] text-text-primary focus:outline-none focus:border-accent-blue/50';
  return (
    <Modal title="Edit account" onClose={onClose} width="max-w-lg"
      footer={<><button onClick={onClose} className="text-[12px] text-text-muted">Cancel</button>
        <button onClick={() => onSave({ ...form, opportunity_value: form.opportunity_value === '' ? null : Number(form.opportunity_value) })} className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium">Save</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Account name" wide><input className={inputCls} value={form.account_name} onChange={set('account_name')} /></Field>
        <Field label="Account type"><select className={inputCls} value={form.account_type} onChange={set('account_type')}>{ACCOUNT_TYPE_TABS.map(t => <option key={t.value} value={t.value}>{t.singular}</option>)}</select></Field>
        <Field label="Industry"><input className={inputCls} value={form.industry} onChange={set('industry')} /></Field>
        <Field label="AE"><input className={inputCls} value={form.ae_name} onChange={set('ae_name')} /></Field>
        <Field label="Close date"><DatePicker selected={parseISODate(form.close_date)} onChange={(d) => setForm(f => ({ ...f, close_date: toISODate(d) }))} dateFormat="MMM d, yyyy" placeholderText="Select date" className={inputCls} popperPlacement="bottom-start" /></Field>
        <Field label="Opportunity value"><input type="number" className={inputCls} value={form.opportunity_value} onChange={set('opportunity_value')} /></Field>
        <Field label="Risk"><select className={inputCls} value={form.risk} onChange={set('risk')}><option value="">—</option>{RISK_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field>
        <Field label="Presales stage"><select className={inputCls} value={form.presales_stage} onChange={set('presales_stage')}><option value="">—</option>{PRESALES_STAGES.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
        <Field label="Escalation"><select className={inputCls} value={form.escalation} onChange={set('escalation')}><option value="">—</option>{ESCALATION_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
        <Field label="Jira ticket URL"><input className={inputCls} value={form.jira_ticket_url} onChange={set('jira_ticket_url')} /></Field>
        <Field label="POV success plan URL" wide><input className={inputCls} value={form.pov_success_plan_url} onChange={set('pov_success_plan_url')} /></Field>
      </div>
      {(form.escalation === 'Tech Blocked' || form.escalation === 'Tech Challenged') && !form.jira_ticket_url.trim() &&
        <div className="text-[11px] text-accent-yellow mt-3">Jira ticket URL is required for this escalation.</div>}
    </Modal>
  );
}

function Field({ label, children, wide }) {
  return <div className={wide ? 'col-span-2' : ''}><label className="text-[10px] text-text-muted block mb-1">{label}</label>{children}</div>;
}

function TranscriptModal({ onClose, onSave }) {
  const [text, setText] = useState('');
  return (
    <Modal title="Paste transcript" onClose={onClose} width="max-w-2xl"
      footer={<><button onClick={onClose} className="text-[12px] text-text-muted">Cancel</button>
        <button onClick={() => onSave(text)} disabled={!text.trim()} className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40">Submit</button></>}>
      <label className="text-[12px] text-text-muted block mb-1.5">Paste raw transcript text below</label>
      <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Paste call transcript…" rows={14} className="w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary focus:outline-none focus:border-accent-blue/50 resize-none" autoFocus />
    </Modal>
  );
}

function TranscriptDropZone({ onFile, busy }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const toast = useToast();
  const ACCEPT = ['.txt', '.md', '.pdf'];

  function handleFiles(files) {
    const file = files && files[0];
    if (!file) return;
    if (!ACCEPT.some(ext => file.name.toLowerCase().endsWith(ext))) {
      toast('Unsupported file — use .txt, .md or .pdf', 'warn');
      return;
    }
    onFile(file);
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); handleFiles(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      className={`border-2 border-dashed rounded-lg p-5 flex flex-col items-center justify-center gap-1.5 cursor-pointer transition ${over ? 'border-accent-blue bg-accent-blue/10' : 'border-border bg-card hover:border-accent-blue/40'}`}>
      <Icon.File width={22} height={22} className="text-text-muted" />
      <div className="text-[12px] text-text-secondary">{busy ? 'Processing transcript…' : 'Drop transcript file here'}</div>
      <div className="text-[10px] text-text-dim">.txt, .md, .pdf — or click to browse</div>
      <input ref={inputRef} type="file" accept=".txt,.md,.pdf" className="hidden"
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
