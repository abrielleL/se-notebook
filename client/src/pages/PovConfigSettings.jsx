import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Card from '../components/Card.jsx';
import Icon from '../components/Icons.jsx';
import TablerIcon from '../components/TablerIcon.jsx';
import { useToast } from '../components/Toast.jsx';

const CATEGORY_LABELS = {
  product: 'Products',
  deployment: 'Deployment',
  technology: 'Technologies',
  file_type: 'File types',
  compliance: 'Compliance',
  os: 'Operating systems',
  use_case: 'Use cases',
  integration: 'Integrations'
};
const CATEGORIES = ['product', 'deployment', 'technology', 'file_type', 'compliance', 'os', 'use_case', 'integration'];
const CHROMA_TOOLTIP = 'ChromaDB folder slugs (comma-separated) — leave blank if no docs folders exist for this item';
const DEPLOY_TOOLTIP = 'Deployment values this product supports (comma-separated) — used to filter deployment chips in the generator';
const splitCsv = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

function EditRow({ item, onSave, onCancel }) {
  const [form, setForm] = useState({
    label: item.label, value: item.value, icon: item.icon || 'ti-circle',
    chroma_filters: (item.chroma_filters || []).join(', '),
    valid_deployments: (item.valid_deployments || []).join(', ')
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!form.label.trim() || !form.value.trim()) {
      setError('Label and value are both required.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onSave({
        label: form.label.trim(),
        value: form.value.trim(),
        icon: (form.icon || 'ti-circle').trim(),
        chroma_filters: splitCsv(form.chroma_filters),
        valid_deployments: splitCsv(form.valid_deployments)
      });
    } catch (e) {
      setError(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 px-3 py-2 border border-accent-blue/30 rounded bg-[#0a1628]">
      <div className="flex items-center flex-wrap gap-2">
        <TablerIcon name={form.icon || 'ti-circle'} className="text-text-muted text-[15px] w-5 text-center" />
        <input value={form.label} onChange={set('label')} placeholder="Label"
          className="flex-1 bg-[#0a0d11] border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/50" />
        <input value={form.value} onChange={set('value')} placeholder="value/slug"
          className="w-24 bg-[#0a0d11] border border-border rounded px-2 py-1 text-[11px] text-text-muted focus:outline-none focus:border-accent-blue/50" />
        <input value={form.icon} onChange={set('icon')} placeholder="ti-icon"
          className="w-28 bg-[#0a0d11] border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/50" />
        <input value={form.chroma_filters} onChange={set('chroma_filters')} placeholder="chroma slugs (a, b)" title={CHROMA_TOOLTIP}
          className="w-36 bg-[#0a0d11] border border-border rounded px-2 py-1 text-[11px] text-accent-blue focus:outline-none focus:border-accent-blue/50" />
        <input value={form.valid_deployments} onChange={set('valid_deployments')} placeholder="deployments (a, b)" title={DEPLOY_TOOLTIP}
          className="w-36 bg-[#0a0d11] border border-border rounded px-2 py-1 text-[11px] text-text-muted focus:outline-none focus:border-accent-blue/50" />
        <button onClick={submit} disabled={saving} className="text-[11px] text-accent-green hover:underline disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button>
        <button onClick={onCancel} className="text-[11px] text-text-muted hover:text-text-primary">Cancel</button>
      </div>
      {error && <div className="text-[10px] text-accent-red px-1">{error}</div>}
    </div>
  );
}

function CategorySection({ category, items, reload }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  // save/add intentionally do NOT catch — errors propagate to EditRow so it can
  // show them inline next to the form. On success we refresh and confirm.
  async function save(id, body) {
    await api.updatePovConfig(id, body);
    setEditing(null);
    reload();
    toast('Item updated', 'success');
  }
  async function add(body) {
    await api.createPovConfig({ category, ...body });
    setAdding(false);
    reload();
    toast('Item added', 'success');
  }
  async function remove(item) {
    if (!window.confirm(`Delete "${item.label}"?`)) return;
    try {
      await api.deletePovConfig(item.id);
      reload();
    } catch (e) { toast(`Delete failed: ${e.message}`, 'error'); }
  }
  async function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const a = items[i], b = items[j];
    try {
      await Promise.all([
        api.updatePovConfig(a.id, { sort_order: b.sort_order }),
        api.updatePovConfig(b.id, { sort_order: a.sort_order })
      ]);
      reload();
    } catch (e) { toast(`Reorder failed: ${e.message}`, 'error'); }
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-[#10141b] hover:bg-[#14181f] transition">
        <span className="text-[12px] font-medium text-text-primary">{CATEGORY_LABELS[category]}</span>
        <span className="text-[11px] text-text-dim">{items.length} · {open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="p-3 flex flex-col gap-1.5">
          {items.map((item, i) => editing === item.id ? (
            <EditRow key={item.id} item={item} onSave={(b) => save(item.id, b)} onCancel={() => setEditing(null)} />
          ) : (
            <div key={item.id} className="flex items-center flex-wrap gap-2 px-3 py-2 border border-border rounded">
              <TablerIcon name={item.icon || 'ti-circle'} className="text-text-muted text-[15px] w-5 text-center" />
              <span className="text-[12px] text-text-primary flex-1 truncate">{item.label}</span>
              <span className="text-[10px] text-text-dim">{item.value}</span>
              {(item.chroma_filters || []).map(f => (
                <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-[#1a2744] text-accent-blue" title={CHROMA_TOOLTIP}>{f}</span>
              ))}
              {(item.valid_deployments || []).map(d => (
                <span key={d} className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e2128] text-text-muted" title={DEPLOY_TOOLTIP}>{d}</span>
              ))}
              <div className="flex items-center gap-0.5">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="text-text-dim hover:text-text-primary disabled:opacity-30 px-1">↑</button>
                <button onClick={() => move(i, 1)} disabled={i === items.length - 1} className="text-text-dim hover:text-text-primary disabled:opacity-30 px-1">↓</button>
              </div>
              <button onClick={() => setEditing(item.id)} className="text-text-muted hover:text-accent-blue"><Icon.Edit width={13} height={13} /></button>
              <button onClick={() => remove(item)} className="text-text-muted hover:text-accent-red"><Icon.Trash width={13} height={13} /></button>
            </div>
          ))}

          {adding ? (
            <EditRow item={{ label: '', value: '', icon: 'ti-circle', chroma_filters: [], valid_deployments: [] }} onSave={add} onCancel={() => setAdding(false)} />
          ) : (
            <button onClick={() => setAdding(true)} className="text-[11px] text-accent-blue hover:underline text-left px-1 pt-1">
              + Add new {CATEGORY_LABELS[category].toLowerCase().replace(/s$/, '')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function PovConfigSettings() {
  const [config, setConfig] = useState(null);
  function reload() { api.getPovConfig().then(setConfig).catch(() => {}); }
  useEffect(() => { reload(); }, []);

  return (
    <Card className="p-6 mt-5">
      <div className="text-[13px] font-medium text-text-primary mb-1">POV generator configuration</div>
      <p className="text-[12px] text-text-muted mb-4 leading-relaxed">
        Manage the chip options shown in the POV preflight. Icons use Tabler names (e.g. <span className="text-accent-blue">ti-shield</span>).
      </p>
      <div className="flex flex-col gap-2">
        {config ? CATEGORIES.map(cat => (
          <CategorySection key={cat} category={cat} items={config[cat] || []} reload={reload} />
        )) : <div className="text-[12px] text-text-dim">Loading…</div>}
      </div>
    </Card>
  );
}
