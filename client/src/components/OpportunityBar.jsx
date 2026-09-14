import { useState } from 'react';
import Icon from './Icons.jsx';
import Modal from './Modal.jsx';
import { api } from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { PRESALES_STAGES } from '../lib/constants.js';

// ---------------------------------------------------------------------------
// The account/opportunity switcher.
//
// An account that has only ever had one deal doesn't show any of this: its
// page stays exactly as it was, and the single opportunity behind it is
// invisible. The strip appears the moment a second deal is added, which is
// also the moment the page starts meaning "company" rather than "deal".
// ---------------------------------------------------------------------------

function stageLabel(o) {
  return o.presales_stage || o.opportunity_stage || '—';
}

export function NewOpportunityModal({ account, onClose, onCreated }) {
  const toast = useToast();
  const existing = (account.opportunities || []).find(o => o.is_default) || (account.opportunities || [])[0];
  const isFirstSplit = (account.opportunities || []).length === 1;

  const [name, setName] = useState('');
  const [renameExisting, setRenameExisting] = useState(existing?.name || '');
  const [stage, setStage] = useState(PRESALES_STAGES[0] || '');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const created = await api.createOpportunity(account.id, {
        name: name.trim(),
        presales_stage: stage || undefined,
        // Only sent on the first split, when the work already on the page
        // needs a name of its own.
        rename_existing: isFirstSplit && renameExisting.trim() !== existing?.name
          ? renameExisting.trim() : undefined
      });
      toast(`Added ${created.name}`, 'success');
      onCreated(created);
    } catch (e) {
      toast(e.message, 'error');
      setSaving(false);
    }
  }

  const field = 'w-full bg-inset border border-border rounded px-2 py-1.5 text-[12px] text-text-primary';

  return (
    <Modal
      title="New opportunity"
      onClose={onClose}
      footer={<>
        <button onClick={onClose} className="text-[12px] text-text-muted">Cancel</button>
        <button onClick={save} disabled={!name.trim() || saving}
          className="bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-3 py-1.5 text-[12px]">
          {saving ? 'Adding…' : 'Add opportunity'}
        </button>
      </>}
    >
      <div className="flex flex-col gap-4">
        <div className="text-[11px] text-text-muted leading-relaxed">
          A second deal at {account.account_name}. It starts empty and inherits the
          company — contacts, environment, files — but keeps its own notes,
          transcripts and next steps.
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-text-dim">New opportunity</span>
          <input autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder="e.g. Data Diodes" className={field} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-text-dim">Starting stage</span>
          <select value={stage} onChange={e => setStage(e.target.value)} className={field}>
            {PRESALES_STAGES.map(s => (
              <option key={s} value={s} className="bg-[#040d1c]">{s}</option>
            ))}
          </select>
        </label>

        {/* Asked here because this is the only moment it can be answered well:
            six months from now nobody remembers what the work already on the
            page was for. */}
        {isFirstSplit && (
          <label className="flex flex-col gap-1 pt-3 border-t border-border">
            <span className="text-[10px] uppercase tracking-wide text-text-dim">
              …and the work already here is
            </span>
            <input value={renameExisting} onChange={e => setRenameExisting(e.target.value)}
              placeholder="e.g. Kiosk &amp; MFT" className={field} />
            <span className="text-[10px] text-text-dim">
              Everything on this account so far — {existing?.open_step_count || 0} open steps,{' '}
              {existing?.note_count || 0} notes, {existing?.pov_count || 0} POVs — moves under this name.
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}

export default function OpportunityBar({ account, value, onChange, onChanged, onAdd }) {
  const toast = useToast();
  const opportunities = account.opportunities || [];
  const [busy, setBusy] = useState(false);

  // One deal means there is nothing to switch between: the page is the deal.
  if (opportunities.length < 2) return null;

  const selected = opportunities.find(o => o.id === value) || null;

  async function close(status) {
    if (!selected) return;
    setBusy(true);
    try {
      await api.closeOpportunity(selected.id, status);
      toast(`${selected.name} marked ${status}`, 'success');
      await onChanged();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function reopen() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.reopenOpportunity(selected.id);
      toast(`${selected.name} reopened`, 'success');
      await onChanged();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.deleteOpportunity(selected.id);
      toast(`${selected.name} removed`, 'success');
      onChange(null);
      await onChanged();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  const tab = (on) =>
    `text-[10px] px-2.5 py-1 rounded whitespace-nowrap border transition hover:opacity-80 ${
      on ? 'bg-active text-accent-blue border-accent-blue/40'
         : 'bg-subtle text-text-muted border-transparent'}`;

  return (
    <div className="px-5 py-2 border-b border-border flex items-center gap-1.5 overflow-x-auto">
      {/* The company itself: everything across every deal, which is where the
          contacts, files and the full picture live. */}
      <button onClick={() => onChange(null)} className={tab(value === null)}>
        <Icon.Folder width={9} height={9} className="inline mr-1 -mt-px" />
        Company
      </button>
      <span className="w-px h-4 bg-border mx-1 shrink-0" />

      {opportunities.map(o => (
        <button key={o.id} onClick={() => onChange(o.id)} className={tab(value === o.id)}
          title={`${stageLabel(o)} · ${o.open_step_count} open step${o.open_step_count === 1 ? '' : 's'}`}>
          {o.archived_at && <span className="opacity-60 mr-1">✓</span>}
          <span className={o.archived_at ? 'opacity-70' : ''}>{o.name}</span>
          {o.open_step_count > 0 && (
            <span className="ml-1.5 opacity-60">{o.open_step_count}</span>
          )}
        </button>
      ))}

      <button onClick={onAdd} className="text-[10px] px-2 py-1 rounded text-text-dim hover:text-accent-blue whitespace-nowrap">
        <Icon.Plus width={9} height={9} className="inline -mt-px" /> New
      </button>

      {/* Per-deal actions sit on the right so they can't be mistaken for the
          account-level Export/Edit in the header above. */}
      {selected && (
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {selected.status !== 'active' && (
            <span className={`text-[9px] uppercase tracking-wide px-1.5 py-[1px] rounded border ${
              selected.status === 'won'
                ? 'text-accent-green border-accent-green/40'
                : 'text-text-dim border-border'}`}>
              {selected.status}
            </span>
          )}
          {selected.archived_at ? (
            <button onClick={reopen} disabled={busy} className="text-[10px] text-text-dim hover:text-accent-blue disabled:opacity-40">
              Reopen
            </button>
          ) : (
            <>
              <button onClick={() => close('won')} disabled={busy} className="text-[10px] text-text-dim hover:text-accent-green disabled:opacity-40">
                Mark won
              </button>
              <button onClick={() => close('lost')} disabled={busy} className="text-[10px] text-text-dim hover:text-accent-red disabled:opacity-40">
                Lost
              </button>
            </>
          )}
          {/* Only offered while the deal is still empty; the server refuses
              otherwise, so splitting an account stays undoable without ever
              putting real notes at risk. */}
          {selected.note_count === 0 && selected.transcript_count === 0
            && selected.open_step_count === 0 && selected.pov_count === 0 && (
            <button onClick={remove} disabled={busy} className="text-[10px] text-text-dim hover:text-accent-red disabled:opacity-40">
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
