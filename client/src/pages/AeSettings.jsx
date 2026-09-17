import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Card from '../components/Card.jsx';
import Icon from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';

function AeRow({ ae, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ae.full_name);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try { await onSave({ full_name: name.trim() }); setEditing(false); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 border border-accent-blue/30 rounded bg-[#111f42]">
        <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} autoFocus
          className="flex-1 min-w-[140px] bg-[#040d1c] border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/50" />
        <button onClick={save} disabled={busy} className="text-[11px] text-accent-green hover:underline disabled:opacity-40">{busy ? 'Saving…' : 'Save'}</button>
        <button onClick={() => { setName(ae.full_name); setEditing(false); }} className="text-[11px] text-text-muted hover:text-text-primary">Cancel</button>
      </div>
    );
  }

  const first = ae.full_name.trim().split(/\s+/)[0];
  return (
    <div className="flex items-center gap-2 px-3 py-2 border border-border rounded group">
      <span className="text-[11px] text-text-primary">{ae.full_name}</span>
      {ae.ambiguous
        ? <span className="text-[10px] text-accent-yellow" title={`More than one AE is called ${first}, so typing "${first}" alone won't expand`}>
            “{first}” is shared — type more
          </span>
        : <span className="text-[10px] text-text-dim">type “{first}”</span>}
      <div className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 transition">
        <button onClick={() => setEditing(true)} className="text-text-dim hover:text-accent-blue"><Icon.Edit width={12} height={12} /></button>
        <button onClick={onDelete} className="text-text-dim hover:text-accent-red"><Icon.Trash width={12} height={12} /></button>
      </div>
    </div>
  );
}

export default function AeSettings() {
  const toast = useToast();
  const [roster, setRoster] = useState([]);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);

  const reload = () => api.listAeRoster().then(setRoster).catch(() => {});
  useEffect(() => { reload(); }, []);

  // Two AEs sharing a first name can't be told apart from that name alone, so
  // the row says so rather than letting the autofill look broken.
  const firstNameCounts = roster.reduce((m, a) => {
    const f = a.full_name.trim().split(/\s+/)[0].toLowerCase();
    m[f] = (m[f] || 0) + 1;
    return m;
  }, {});
  const rows = roster.map(a => ({
    ...a,
    ambiguous: firstNameCounts[a.full_name.trim().split(/\s+/)[0].toLowerCase()] > 1
  }));

  async function add() {
    if (!name.trim()) return;
    setAdding(true);
    try {
      await api.createAe({ full_name: name.trim() });
      setName('');
      await reload();
    } catch (e) {
      toast(e.message || 'Could not add AE', 'error');
    } finally { setAdding(false); }
  }

  async function save(id, body) {
    try {
      const r = await api.updateAe(id, body);
      await reload();
      if (r.renamed_accounts) {
        toast(`Renamed on ${r.renamed_accounts} account${r.renamed_accounts > 1 ? 's' : ''}`, 'success');
      }
    } catch (e) {
      toast(e.message || 'Save failed', 'error');
    }
  }

  async function remove(ae) {
    if (!confirm(`Remove ${ae.full_name} from the roster? Accounts that name them keep the name — this only stops the autofill offering it.`)) return;
    try { await api.deleteAe(ae.id); await reload(); }
    catch (e) { toast(e.message || 'Delete failed', 'error'); }
  }

  return (
    <Card className="p-6 mt-6">
      <div className="text-[13px] font-medium text-text-primary mb-1">Account Executives</div>
      <p className="text-[12px] text-text-muted mb-4 leading-relaxed">
        Full names of the AEs you work with. Type just a first name in an account's AE field and it fills in the
        full name from this list, so exported POV documents carry the whole name. A first name shared by two
        people is left exactly as you typed it rather than guessed at. Renaming someone here updates every
        account that names them.
      </p>

      <div className="flex flex-col gap-1.5 mb-4">
        {rows.length === 0 && <div className="text-[11px] text-text-dim px-1">No AEs yet. Add one below.</div>}
        {rows.map(a => (
          <AeRow key={a.id} ae={a} onSave={(b) => save(a.id, b)} onDelete={() => remove(a)} />
        ))}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border border-dashed border-border rounded">
        <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
          placeholder="Full name, e.g. Rob Emmerich"
          className="flex-1 min-w-[140px] bg-[#040d1c] border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/50" />
        <button onClick={add} disabled={!name.trim() || adding}
          className="flex items-center gap-1 text-[11px] text-accent-blue hover:underline disabled:opacity-40">
          <Icon.Plus width={12} height={12} /> {adding ? 'Adding…' : 'Add AE'}
        </button>
      </div>
    </Card>
  );
}
