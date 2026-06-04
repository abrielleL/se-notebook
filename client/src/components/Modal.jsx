import { useEffect } from 'react';
import Icon from './Icons.jsx';

// Centered modal overlay. Escape and backdrop click close it.
export default function Modal({ title, onClose, children, width = 'max-w-lg', footer }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[150] flex items-start justify-center p-6 bg-black/60 backdrop-blur-sm overflow-auto"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`w-full ${width} bg-card border border-border rounded-lg shadow-2xl my-8`}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="text-[13px] font-semibold text-text-primary">{title}</div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <Icon.X width={14} height={14} />
          </button>
        </div>
        <div className="p-5">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}
