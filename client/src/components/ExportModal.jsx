import { useState, useMemo, useEffect } from 'react';
import Modal from './Modal.jsx';
import { api } from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { EXPORT_SECTIONS, EXPORT_PRESETS, QUAL_FIELDS } from '../lib/constants.js';
import { formatDate } from '../lib/stage.js';

const trunc = (s, n) => {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// Count success criteria from the active POV's Section 4 table (best-effort).
function criteriaCount(pov) {
  if (!pov || !pov.section_texts) return null;
  const st = pov.section_texts;
  const key = Object.keys(st).find(k => /SECTION\s*4/i.test(k));
  if (!key) return null;
  const rows = String(st[key]).split('\n').filter(l => l.includes('|') && /^\s*\|?\s*\d+\b/.test(l));
  if (!rows.length) return null;
  const met = rows.filter(l => /\[x\]|☑/i.test(l)).length;
  return { met, total: rows.length };
}

// Export selector modal — section chips + a live content preview of the
// real data that will be exported. Data is passed down from AccountDetail
// (already loaded) rather than re-fetched.
export default function ExportModal({ accountId, accountName, account = {}, di = {}, snapshot, pov, onClose }) {
  const [selected, setSelected] = useState(new Set(EXPORT_PRESETS.customer));
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState([]);
  const toast = useToast();

  useEffect(() => { api.listFiles(accountId).then(setFiles).catch(() => {}); }, [accountId]);

  const toggle = (key) => setSelected(s => {
    const next = new Set(s);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const setAll = (keys) => setSelected(new Set(keys));

  // Build the preview lines for a given section key. Returns string[] (empty = no data).
  function linesFor(key) {
    switch (key) {
      case 'summary': return account.ai_summary ? [trunc(account.ai_summary, 300)] : [];
      case 'drivers': return account.ai_technical_drivers ? [trunc(account.ai_technical_drivers, 200)] : [];
      case 'environment': return account.ai_environment ? [trunc(account.ai_environment, 200)] : [];
      case 'next_steps':
        return (account.next_steps || []).filter(s => !s.completed).slice(0, 5)
          .map(s => `${s.text}${s.due_date ? ` — ${formatDate(s.due_date)}` : ''}`);
      case 'contacts':
        return (account.contacts || []).slice(0, 5).map(c => `${c.name}${c.title ? ` — ${c.title}` : ''}`);
      case 'qualification':
        return QUAL_FIELDS
          .filter(f => di[f.key] && di[f.key].value && di[f.key].value.trim())
          .map(f => `${f.label}: ${trunc(di[f.key].value, 80)}`);
      case 'notes':
        return (account.notes || []).slice(0, 3).map(n => `${formatDate(n.date)}${n.note_type ? ` · ${n.note_type}` : ''}`);
      case 'crm_snapshot':
        return snapshot && snapshot.snapshot_text ? [snapshot.snapshot_text] : [];
      case 'active_pov': {
        if (!pov) return [];
        const crit = criteriaCount(pov);
        const range = (pov.start_date || pov.end_date)
          ? `${pov.start_date ? formatDate(pov.start_date) : '?'} – ${pov.end_date ? formatDate(pov.end_date) : '?'}` : '';
        const head = `POV #${pov.id} · ${pov.status || 'Draft'}${crit ? ` · ${crit.met}/${crit.total} criteria met` : ''}`;
        return [head, range].filter(Boolean);
      }
      case 'se_prep_notes':
        return pov && pov.se_prep_notes ? [trunc(pov.se_prep_notes, 200)] : [];
      case 'attachments':
        return files.map(f => `${f.original_name} · ${f.category}`);
      default: return [];
    }
  }

  const blocks = useMemo(
    () => EXPORT_SECTIONS.filter(s => selected.has(s.key)).map(s => ({ s, lines: linesFor(s.key) })),
    [selected, account, di, snapshot, pov, files]
  );

  const { words, pages } = useMemo(() => {
    const chars = blocks.reduce((sum, b) => sum + b.lines.join(' ').length, 0);
    const w = Math.round(chars / 5);
    return { words: w, pages: Math.max(1, Math.ceil(w / 400)) };
  }, [blocks]);

  async function exportPdf() {
    setBusy(true);
    try {
      const { html } = await api.exportPdf(accountId, [...selected]);
      const w = window.open('', '_blank');
      if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 400); }
      else toast('Popup blocked — allow popups to print.', 'warn');
    } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }

  async function exportDocx() {
    setBusy(true);
    try {
      const { blob, filename } = await api.exportDocx(accountId, [...selected]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast(`Export failed: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Export account — ${accountName}`} onClose={onClose} width="max-w-2xl"
      footer={
        <>
          <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-primary">Cancel</button>
          <button onClick={exportPdf} disabled={busy || !selected.size}
            className="bg-card border border-border rounded px-3 py-1.5 text-[12px] text-text-primary hover:border-accent-blue/40 disabled:opacity-40">Export PDF</button>
          <button onClick={exportDocx} disabled={busy || !selected.size}
            className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium hover:bg-accent-blue/25 disabled:opacity-40">Export .docx</button>
        </>
      }>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setAll(EXPORT_PRESETS.customer)} className="text-[11px] px-2.5 py-1 rounded border border-border text-text-muted hover:text-text-primary">Customer-facing</button>
          <button onClick={() => setAll(EXPORT_PRESETS.full)} className="text-[11px] px-2.5 py-1 rounded border border-border text-text-muted hover:text-text-primary">Full SE export</button>
          <button onClick={() => setAll(EXPORT_SECTIONS.map(s => s.key))} className="text-[11px] px-2.5 py-1 rounded border border-border text-text-muted hover:text-text-primary">Select all</button>
          <button onClick={() => setAll([])} className="text-[11px] px-2.5 py-1 rounded border border-border text-text-muted hover:text-text-primary">Clear all</button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {EXPORT_SECTIONS.map(s => {
            const on = selected.has(s.key);
            return (
              <button key={s.key} onClick={() => toggle(s.key)}
                className={`text-left px-3 py-2 rounded border text-[12px] transition ${on ? 'bg-accent-blue/15 border-accent-blue/40 text-accent-blue' : 'bg-card border-border text-text-muted hover:text-text-primary'}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-3 h-3 rounded-sm border ${on ? 'bg-accent-blue border-accent-blue' : 'border-text-dim'}`} />
                  {s.label}
                </div>
                {s.private && <div className="text-[10px] text-accent-yellow mt-0.5 pl-5">Private · not customer-facing</div>}
              </button>
            );
          })}
        </div>

        {/* Live content preview — scrolls independently inside the modal */}
        <div className="border border-border rounded bg-[#10141b]">
          <div className="px-3 py-2 border-b border-border text-[11px] text-text-muted">
            Document preview · {selected.size} section{selected.size === 1 ? '' : 's'}
          </div>
          <div className="px-3 py-2 overflow-y-auto" style={{ maxHeight: 400 }}>
            {blocks.length === 0 && <div className="text-[11px] italic text-text-dim py-4 text-center">No sections selected.</div>}
            {blocks.map((b, i) => (
              <div key={b.s.key}>
                {i > 0 && <div className="border-t border-border my-2.5" />}
                <div className="pl-3 border-l-2 border-[#0066CC]">
                  {b.s.private && <div className="text-[10px] font-bold text-accent-red mb-1">INTERNAL — NOT FOR DISTRIBUTION</div>}
                  <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1">{b.s.label}</div>
                  {b.lines.length
                    ? b.lines.map((l, j) => <div key={j} className="text-[11px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words">{l}</div>)
                    : <div className="text-[11px] italic text-text-dim">No {b.s.label.toLowerCase()} recorded yet</div>}
                </div>
              </div>
            ))}
          </div>
          {blocks.length > 0 && (
            <div className="px-3 py-2 border-t border-border text-[10px] text-text-dim">
              ~{words} words · estimated {pages} page{pages === 1 ? '' : 's'}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
