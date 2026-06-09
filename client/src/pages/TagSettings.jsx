import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Card from '../components/Card.jsx';
import Icon from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';

// Preset chip colors (app accent palette).
const COLORS = ['#58a6ff', '#3fb950', '#e3b341', '#bc8cff', '#f0883e', '#f85149', '#8b949e'];

function ColorSwatches({ value, onChange }) {
  return (
    <div className="flex items-center gap-1.5">
      {COLORS.map(c => (
        <button key={c} type="button" onClick={() => onChange(c)}
          className={`w-4 h-4 rounded-full border transition ${value === c ? 'border-text-primary scale-110' : 'border-transparent'}`}
          style={{ background: c }} title={c} />
      ))}
    </div>
  );
}

function TagRow({ tag, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(tag.label);
  const [color, setColor] = useState(tag.color);
  const [inactive, setInactive] = useState(tag.is_inactive);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!label.trim()) return;
    setBusy(true);
    try { await onSave({ label: label.trim(), color, is_inactive: inactive }); setEditing(false); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <div className="flex items-center flex-wrap gap-2 px-3 py-2 border border-accent-blue/30 rounded bg-[#0a1628]">
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label" autoFocus
          className="flex-1 min-w-[140px] bg-[#0a0d11] border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/50" />
        <ColorSwatches value={color} onChange={setColor} />
        <label className="flex items-center gap-1 text-[10px] text-text-muted cursor-pointer">
          <input type="checkbox" checked={inactive} onChange={e => setInactive(e.target.checked)} /> inactive
        </label>
        <button onClick={save} disabled={busy} className="text-[11px] text-accent-green hover:underline disabled:opacity-40">{busy ? 'Saving…' : 'Save'}</button>
        <button onClick={() => setEditing(false)} className="text-[11px] text-text-muted hover:text-text-primary">Cancel</button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 border border-border rounded group">
      <span className="text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0"
        style={{ color: tag.color, background: `${tag.color}22`, border: `1px solid ${tag.color}55` }}>
        {tag.label}
      </span>
      {tag.is_inactive && (
        <span className="text-[10px] text-text-dim" title="Accounts with this tag are hidden from the dashboard's active views">
          hides from dashboard
        </span>
      )}
      <div className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 transition">
        <button onClick={() => setEditing(true)} className="text-text-dim hover:text-accent-blue"><Icon.Edit width={12} height={12} /></button>
        <button onClick={onDelete} className="text-text-dim hover:text-accent-red"><Icon.Trash width={12} height={12} /></button>
      </div>
    </div>
  );
}

export default function TagSettings() {
  const toast = useToast();
  const [tags, setTags] = useState([]);
  const [label, setLabel] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [inactive, setInactive] = useState(false);
  const [adding, setAdding] = useState(false);

  const reload = () => api.listTags().then(setTags).catch(() => {});
  useEffect(() => { reload(); }, []);

  async function add() {
    if (!label.trim()) return;
    setAdding(true);
    try {
      await api.createTag({ label: label.trim(), color, is_inactive: inactive });
      setLabel(''); setColor(COLORS[0]); setInactive(false);
      await reload();
    } catch (e) {
      toast(e.message || 'Could not add tag', 'error');
    } finally { setAdding(false); }
  }

  async function save(id, body) {
    try { await api.updateTag(id, body); await reload(); }
    catch (e) { toast(e.message || 'Save failed', 'error'); }
  }

  async function remove(tag) {
    if (!confirm(`Delete the tag "${tag.label}"? It will be removed from all accounts.`)) return;
    try { await api.deleteTag(tag.id); await reload(); }
    catch (e) { toast(e.message || 'Delete failed', 'error'); }
  }

  return (
    <Card className="p-6 mt-6">
      <div className="text-[13px] font-medium text-text-primary mb-1">Account Tags</div>
      <p className="text-[12px] text-text-muted mb-4 leading-relaxed">
        Reusable labels you can apply to accounts (e.g. “renewal only”, “strategic”). Tags are searchable in the global
        search bar and filterable on the Accounts page. Mark a tag <span className="text-text-secondary">inactive</span> to
        drop accounts that carry it out of the dashboard’s active POV &amp; pipeline views.
      </p>

      <div className="flex flex-col gap-1.5 mb-4">
        {tags.length === 0 && <div className="text-[11px] text-text-dim px-1">No tags yet. Add one below.</div>}
        {tags.map(t => (
          <TagRow key={t.id} tag={t} onSave={(b) => save(t.id, b)} onDelete={() => remove(t)} />
        ))}
      </div>

      <div className="flex items-center flex-wrap gap-2 px-3 py-2 border border-dashed border-border rounded">
        <input value={label} onChange={e => setLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
          placeholder="New tag label…"
          className="flex-1 min-w-[140px] bg-[#0a0d11] border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/50" />
        <ColorSwatches value={color} onChange={setColor} />
        <label className="flex items-center gap-1 text-[10px] text-text-muted cursor-pointer">
          <input type="checkbox" checked={inactive} onChange={e => setInactive(e.target.checked)} /> inactive
        </label>
        <button onClick={add} disabled={!label.trim() || adding}
          className="flex items-center gap-1 text-[11px] text-accent-blue hover:underline disabled:opacity-40">
          <Icon.Plus width={12} height={12} /> {adding ? 'Adding…' : 'Add tag'}
        </button>
      </div>
    </Card>
  );
}
