import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import TablerIcon from '../components/TablerIcon.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate } from '../lib/stage.js';

const CATEGORY_LABELS = {
  diagram: 'Diagram', document: 'Document', screenshot: 'Screenshot',
  proposal: 'Proposal', contract: 'Contract', other: 'Other'
};

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function isImage(f) {
  if ((f.mime_type || '').startsWith('image/')) return true;
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes((f.type || '').toLowerCase());
}
function isPdf(f) {
  return (f.mime_type || '').includes('pdf') || (f.type || '').toLowerCase() === 'pdf';
}

function fileIcon(f) {
  const mime = (f.mime_type || '').toLowerCase();
  const ft = (f.type || '').toLowerCase();
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ft)) return 'ti-photo';
  if (mime === 'application/pdf' || ft === 'pdf') return 'ti-file-type-pdf';
  if (mime.includes('wordprocessingml') || mime.includes('msword') || ['doc', 'docx'].includes(ft)) return 'ti-file-type-doc';
  if (mime.includes('spreadsheetml') || mime.includes('excel') || ['xls', 'xlsx'].includes(ft)) return 'ti-file-type-xls';
  if (mime.includes('presentationml') || mime.includes('powerpoint') || ['ppt', 'pptx'].includes(ft)) return 'ti-presentation';
  return 'ti-file';
}

export default function FileLibrary() {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [catFilter, setCatFilter] = useState('All');
  const [acctFilter, setAcctFilter] = useState('All');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [lightbox, setLightbox] = useState(null);

  const load = () => {
    setLoading(true);
    api.listAllFiles().then(setFiles).catch(() => toast('Failed to load files', 'error')).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!lightbox) return;
    const h = (e) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [lightbox]);

  const accounts = useMemo(() => {
    const m = new Map();
    files.forEach(f => { if (f.account_id) m.set(f.account_id, f.account_name); });
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [files]);

  const cats = useMemo(() => {
    const s = new Set(files.map(f => f.category || 'other'));
    return ['All', ...Array.from(s)];
  }, [files]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter(f => {
      if (catFilter !== 'All' && (f.category || 'other') !== catFilter) return false;
      if (acctFilter !== 'All' && f.account_id !== acctFilter) return false;
      if (!q) return true;
      return (f.original_name || '').toLowerCase().includes(q) ||
             (f.description || '').toLowerCase().includes(q) ||
             (f.account_name || '').toLowerCase().includes(q);
    });
  }, [files, query, catFilter, acctFilter]);

  async function remove(f) {
    try {
      if (f.source === 'attachment') await api.deleteAttachment(f.id);
      else await api.deleteFile(f.id);
      setFiles(prev => prev.filter(x => !(x.id === f.id && x.source === f.source)));
      setConfirmDelete(null);
      toast('File deleted', 'success');
    } catch {
      toast('Delete failed', 'error');
      setConfirmDelete(null);
    }
  }

  function download(f) {
    const a = document.createElement('a');
    a.href = f.url;
    a.download = f.original_name || f.filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function preview(f) {
    if (isImage(f)) setLightbox(f);
    else if (isPdf(f)) window.open(f.url, '_blank');
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Attachment Library</h1>
          <div className="text-[12px] text-text-muted mt-1">
            {files.length} file{files.length === 1 ? '' : 's'} across all accounts · {filtered.length} shown
          </div>
        </div>
      </div>

      <input
        type="text"
        placeholder="Search by file name, description, or account"
        value={query}
        onChange={e => setQuery(e.target.value)}
        className="w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50 mb-3"
      />

      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        {cats.map(c => (
          <button key={c} onClick={() => setCatFilter(c)}
            className={`px-2.5 py-1 rounded text-[11px] border transition ${
              catFilter === c ? 'bg-accent-blue/15 text-accent-blue border-accent-blue/30' : 'bg-card text-text-muted border-border hover:text-text-primary'
            }`}>
            {c === 'All' ? 'All types' : (CATEGORY_LABELS[c] || c)}
          </button>
        ))}
        {accounts.length > 0 && (
          <select value={acctFilter} onChange={e => setAcctFilter(e.target.value)}
            className="ml-auto bg-card border border-border rounded px-2 py-1 text-[11px] text-text-muted focus:outline-none focus:border-accent-blue/50">
            <option value="All">All accounts</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>

      {loading ? (
        <div className="text-[12px] text-text-muted py-8 text-center">Loading files…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-text-dim text-[12px] border border-dashed border-border rounded-lg">
          {files.length === 0
            ? 'No files in the notebook yet. Upload files from any account page.'
            : 'No files match your filters.'}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {filtered.map(f => {
            const confirming = confirmDelete === `${f.source}:${f.id}`;
            const canPreview = isImage(f) || isPdf(f);
            return (
              <div key={`${f.source}:${f.id}`}
                className="flex items-center gap-3 px-3 py-2.5 bg-card border border-border rounded hover:border-accent-blue/40 transition">
                <TablerIcon name={fileIcon(f)} className="text-[18px] text-text-muted shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-text-primary truncate">{f.original_name || f.filename}</div>
                  <div className="text-[10px] text-text-muted truncate">
                    <Link to={`/accounts/${f.account_id}`} className="text-accent-blue hover:underline">{f.account_name}</Link>
                    {' · '}{formatBytes(f.size)}{' · '}{formatDate(f.created_at)}
                    {f.description ? <span className="italic"> · {f.description}</span> : null}
                  </div>
                </div>
                {f.category && f.category !== 'other' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#111f42] text-text-muted border border-border shrink-0">
                    {CATEGORY_LABELS[f.category] || f.category}
                  </span>
                )}
                <div className="flex items-center gap-2 shrink-0">
                  {confirming ? (
                    <>
                      <span className="text-[10px] text-text-muted">Delete?</span>
                      <button onClick={() => remove(f)} className="text-[10px] text-accent-red hover:underline">Yes</button>
                      <span className="text-[10px] text-text-dim">/</span>
                      <button onClick={() => setConfirmDelete(null)} className="text-[10px] text-text-muted hover:underline">No</button>
                    </>
                  ) : (
                    <>
                      {canPreview && (
                        <button onClick={() => preview(f)} title="Preview" className="text-text-dim hover:text-accent-blue">
                          <TablerIcon name="ti-eye" className="text-[14px]" />
                        </button>
                      )}
                      <button onClick={() => download(f)} title="Download" className="text-text-dim hover:text-accent-blue">
                        <TablerIcon name="ti-download" className="text-[14px]" />
                      </button>
                      <button onClick={() => setConfirmDelete(`${f.source}:${f.id}`)} title="Delete" className="text-text-dim hover:text-accent-red">
                        <TablerIcon name="ti-trash" className="text-[14px]" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {lightbox && (
        <div className="fixed inset-0 z-[200] bg-black/85 flex items-center justify-center" onClick={() => setLightbox(null)}>
          <button className="absolute top-4 right-4 text-white hover:text-text-muted" onClick={() => setLightbox(null)}>
            <TablerIcon name="ti-x" className="text-[20px]" />
          </button>
          <div className="flex flex-col items-center gap-2" onClick={e => e.stopPropagation()}>
            <img src={lightbox.url} alt={lightbox.original_name} className="max-w-[90vw] max-h-[90vh] object-contain rounded" />
            <span className="text-[12px] text-white">{lightbox.original_name}</span>
          </div>
        </div>
      )}
    </div>
  );
}
