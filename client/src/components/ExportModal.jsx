import { useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icons.jsx';
import { api } from '../lib/api.js';
import { useToast } from './Toast.jsx';

// POV export is fixed to the branded POV document (.docx only) — no section picker.
const POV_SECTIONS = ['active_pov'];

export default function ExportModal({ accountId, accountName, pov, onClose }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const povId = pov?.id;
  const hasPov = !!(pov && pov.section_texts && Object.keys(pov.section_texts).length);

  async function exportDocx() {
    setBusy(true);
    try {
      const { blob, filename } = await api.exportDocx(accountId, POV_SECTIONS, povId, 'pov');
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
        <p className="text-[12px] text-text-muted">Exports the branded POV document as a Word file.</p>

        {!hasPov && (
          <div className="text-[11px] text-accent-yellow">
            No POV document found for this account — generate one first.
          </div>
        )}

        <button onClick={exportDocx} disabled={busy || !hasPov}
          className="flex items-center justify-center gap-2 bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-4 py-3 text-[12px] font-medium hover:bg-accent-blue/25 disabled:opacity-40">
          <Icon.Download width={14} height={14} /> Export .docx
        </button>

        {busy && <div className="text-[11px] text-text-dim">Preparing export…</div>}
      </div>
    </Modal>
  );
}
