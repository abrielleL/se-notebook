import { useEffect, useState, useRef } from 'react';
import Modal from './Modal.jsx';
import { api } from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { useOnline } from '../lib/offline.jsx';
import { todayISO } from '../lib/stage.js';
import { runFullExtraction } from '../lib/ai.js';
import { upsertDraft, deleteDraft, getDraft, newDraftId } from '../lib/drafts.js';

const meaningful = (t) => !!t.trim();

// Global quick-capture modal, opened with the `Q` shortcut (when not typing
// in a field). Save runs the full AI extraction pipeline; offline disables it.
export default function QuickCapture() {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [draftId, setDraftId] = useState(null);
  const toast = useToast();
  const online = useOnline();
  const taRef = useRef(null);

  function openFresh() {
    setDraftId(newDraftId());
    setText(''); setAccountId('');
    setOpen(true);
  }

  useEffect(() => {
    function onKey(e) {
      const tag = (e.target?.tagName || '').toLowerCase();
      const inField = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
      if (e.key.toLowerCase() === 'q' && !inField && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        openFresh();
      }
    }
    function onOpen(e) {
      const id = e?.detail?.draftId;
      const d = id && getDraft(id);
      if (d) {
        setDraftId(d.id);
        setAccountId(d.payload?.accountId || '');
        setText(d.payload?.text ?? d.text ?? '');
        setOpen(true);
      } else {
        openFresh();
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('open-quick-capture', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('open-quick-capture', onOpen);
    };
  }, []);

  // Autosave the in-progress note as a draft while the modal is open.
  useEffect(() => {
    if (!open || !draftId || !meaningful(text)) return;
    upsertDraft({
      id: draftId,
      source: 'quick-capture',
      accountId: accountId || null,
      accountName: accounts.find(a => a.id === accountId)?.account_name || '',
      text,
      payload: { accountId, text }
    });
  }, [open, draftId, text, accountId, accounts]);

  useEffect(() => {
    if (open) {
      api.listAccounts().then(setAccounts).catch(() => {});
      setTimeout(() => taRef.current?.focus(), 50);
    }
  }, [open]);

  function reset() {
    setText(''); setAccountId(''); setOpen(false);
  }

  async function save() {
    if (!accountId) return;
    if (!text.trim()) {
      toast('Please add some notes before saving.', 'warn');
      return;
    }
    setSaving(true);
    try {
      const note = await api.createNote({
        account_id: accountId, date: todayISO(), raw_notes: text,
        pending_ai_extraction: online ? 0 : 1
      });
      if (online) {
        runFullExtraction(accountId, note.id)
          .then(r => {
            const created = (r.contacts || []).filter(c => c.created).length;
            let msg = `Note saved. ${r.fieldsUpdated.length} fields updated.`;
            if (created) msg += ` ${created} contact${created > 1 ? 's' : ''} extracted.`;
            toast(msg, 'success');
          })
          .catch(() => toast('Note saved. AI extraction failed.', 'warn'));
      } else {
        toast('Note saved offline. AI extraction will run when back online.', 'warn');
      }
      if (draftId) deleteDraft(draftId);
      reset();
    } catch (e) {
      toast(`Save failed: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <Modal title="Quick capture" onClose={reset} width="max-w-xl"
      footer={
        <>
          <button onClick={reset} className="text-[12px] text-text-muted hover:text-text-primary">Cancel</button>
          <button
            onClick={save}
            disabled={!accountId || !text.trim() || saving}
            title={!online ? 'AI features require internet connection' : undefined}
            className="bg-accent-blue/15 hover:bg-accent-blue/25 text-accent-blue border border-accent-blue/30 rounded px-4 py-1.5 text-[12px] font-medium disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <select value={accountId} onChange={e => setAccountId(e.target.value)}
            className="flex-1 bg-[#040d1c] border border-border rounded px-2 py-1.5 text-[12px] text-text-primary focus:outline-none focus:border-accent-blue/50">
            <option value="">Select account…</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
          </select>
        </div>
        <textarea
          ref={taRef}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Paste or type raw notes…"
          style={{ height: 300 }}
          className="w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50 resize-none"
        />
        {!online && <div className="text-[11px] text-accent-yellow">Offline — note will be saved locally and extracted when reconnected.</div>}
      </div>
    </Modal>
  );
}
