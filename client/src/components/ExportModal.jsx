import { useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icons.jsx';
import { api } from '../lib/api.js';
import { useToast } from './Toast.jsx';

// POV export is fixed to the POV document — no section picker. Choose a format.
const POV_SECTIONS = ['active_pov'];

export default function ExportModal({ accountId, accountName, pov, onClose }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const povId = pov?.id;
  const hasPov = !!(pov && pov.section_texts && Object.keys(pov.section_texts).length);

  async function exportPdf() {
    setBusy(true);
    try {
      const { html } = await api.exportPdf(accountId, POV_SECTIONS, povId);
      const w = window.open('', '_blank');
      if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 400); }
      else toast('Popup blocked — allow popups to print.', 'warn');
    } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }

  async function exportDocx() {
    setBusy(true);
    try {
      const { blob, filename } = await api.exportDocx(accountId, POV_SECTIONS, povId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Export POV — ${accountName}`} onClose={onClose} width="max-w-sm">
      <div className="flex flex-col gap-4">
        <p className="text-[12px] text-text-muted">Exports the POV document. Choose a format:</p>

        {!hasPov && (
          <div className="text-[11px] text-accent-yellow">
            No POV document found for this account — generate one first.
          </div>
        )}

        <div className="flex gap-3">
          <button onClick={exportPdf} disabled={busy || !hasPov}
            className="flex-1 flex items-center justify-center gap-2 bg-card border border-border rounded px-4 py-3 text-[12px] text-text-primary hover:border-accent-blue/40 disabled:opacity-40">
            <Icon.Export width={14} height={14} /> PDF
          </button>
          <button onClick={exportDocx} disabled={busy || !hasPov}
            className="flex-1 flex items-center justify-center gap-2 bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-4 py-3 text-[12px] font-medium hover:bg-accent-blue/25 disabled:opacity-40">
            <Icon.Download width={14} height={14} /> .docx
          </button>
        </div>

        {busy && <div className="text-[11px] text-text-dim">Preparing export…</div>}
      </div>
    </Modal>
  );
}
