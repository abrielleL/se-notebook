import { useState, useEffect } from 'react';
import Drawer from './Drawer.jsx';

// Right-side drawer for expanding/editing a truncated field (AI summary,
// drivers, environment, the 8 qualification fields, SE prep notes).
// `history` is an array of { when, what } describing AI appends.
export default function FieldDrawer({ title, value, history = [], footNote, onSave, onClose }) {
  const [text, setText] = useState(value || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setText(value || ''); }, [title, value]);

  async function save() {
    setSaving(true);
    try { await onSave(text); onClose(); }
    finally { setSaving(false); }
  }

  return (
    <Drawer title={title} onClose={onClose}
      footer={
        <>
          <span className="text-[10px] text-text-dim mr-auto">{footNote}</span>
          <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-primary">Discard</button>
          <button onClick={save} disabled={saving}
            className="bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium hover:bg-accent-blue/25 disabled:opacity-40">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        className="w-full h-64 bg-[#0a0d11] border border-border rounded px-3 py-2 text-[12px] text-text-primary leading-relaxed focus:outline-none focus:border-accent-blue/50 resize-none whitespace-pre-wrap"
      />
      {history.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] text-text-muted mb-2">Update history</div>
          <div className="flex flex-col gap-1.5">
            {history.map((h, i) => (
              <div key={i} className="text-[10px] text-text-dim border border-border rounded px-2 py-1.5">
                <span className="text-text-muted">{h.when}</span> — {h.what}
              </div>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}
