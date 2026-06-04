import { useEffect } from 'react';
import Icon from './Icons.jsx';

// Right-side drawer that overlays the right column. The layout underneath
// stays intact; a transparent click-catcher closes it.
export default function Drawer({ title, onClose, children, footer, width = 420 }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-[140] bg-black/30" onMouseDown={onClose} />
      <div
        className="fixed top-0 right-0 bottom-0 z-[141] bg-card border-l border-border shadow-2xl flex flex-col"
        style={{ width }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="text-[13px] font-semibold text-text-primary truncate">{title}</div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary shrink-0">
            <Icon.X width={14} height={14} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </>
  );
}
