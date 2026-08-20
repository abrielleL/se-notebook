import { useNavigate } from 'react-router-dom';
import Icon from '../components/Icons.jsx';
import { useDrafts, deleteDraft } from '../lib/drafts.js';

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

function snippet(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 160);
}

const SOURCE_LABEL = { 'new-note': 'New note', 'quick-capture': 'Quick capture' };

export default function Drafts() {
  const navigate = useNavigate();
  const drafts = useDrafts();

  function resume(d) {
    if (d.source === 'quick-capture') {
      window.dispatchEvent(new CustomEvent('open-quick-capture', { detail: { draftId: d.id } }));
    } else {
      navigate(`/new?draft=${d.id}`);
    }
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Drafts</h1>
          <div className="text-[12px] text-text-muted mt-1">Unsaved notes you started. Resume to finish saving, or discard.</div>
        </div>
        <span className="text-[11px] text-text-muted">{drafts.length} draft{drafts.length === 1 ? '' : 's'}</span>
      </div>

      {drafts.length === 0 ? (
        <div className="text-center py-16 text-text-dim text-[12px] border border-dashed border-border rounded-lg">
          No drafts. Notes you start but don't save will appear here.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {drafts.map(d => (
            <div key={d.id} className="bg-card border border-border rounded-lg p-4 flex items-start gap-3 hover:border-accent-blue/40 transition">
              <div className="min-w-0 flex-1 cursor-pointer" onClick={() => resume(d)}>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-text-primary truncate">{d.accountName || 'New account'}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#111f42] text-text-muted border border-border shrink-0">{SOURCE_LABEL[d.source] || 'Draft'}</span>
                  <span className="text-[10px] text-text-dim shrink-0 ml-auto">{relativeTime(d.updatedAt)}</span>
                </div>
                <div className="text-[11px] text-text-muted mt-1 line-clamp-2">
                  {snippet(d.text) || <span className="italic text-text-dim">No content yet</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => resume(d)} className="text-[11px] px-2.5 py-1 rounded bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25">Resume</button>
                <button onClick={() => deleteDraft(d.id)} title="Discard draft" className="text-text-dim hover:text-accent-red"><Icon.Trash width={13} height={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
