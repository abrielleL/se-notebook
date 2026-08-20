import { createContext, useContext, useState, useCallback } from 'react';

const ToastContext = createContext(() => {});
export function useToast() { return useContext(ToastContext); }

const TYPE_STYLES = {
  info: 'border-accent-blue/40 text-accent-blue bg-[#111f42]',
  success: 'border-accent-green/40 text-accent-green bg-[#032417]',
  error: 'border-accent-red/40 text-accent-red bg-[#290b17]',
  warn: 'border-accent-yellow/40 text-accent-yellow bg-[#2e1d18]'
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, type = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 max-w-sm">
        {toasts.map(t => (
          <div key={t.id} className={`px-4 py-2.5 rounded border text-[12px] shadow-lg ${TYPE_STYLES[t.type] || TYPE_STYLES.info}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
