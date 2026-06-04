import { useEffect, useState, createContext, useContext } from 'react';

// Offline detection: browser online/offline events plus a /api/health ping
// every 60s. Two consecutive failed pings (or navigator.onLine === false)
// marks the app offline.
const OfflineContext = createContext({ online: true });

export function useOnline() {
  return useContext(OfflineContext).online;
}

export function OfflineProvider({ children }) {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    let fails = 0;
    let cancelled = false;

    async function ping() {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (!cancelled) setOnline(false);
        return;
      }
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) throw new Error('bad status');
        fails = 0;
        if (!cancelled) setOnline(true);
      } catch {
        fails += 1;
        if (fails >= 2 && !cancelled) setOnline(false);
      }
    }

    const onOnline = () => { fails = 0; setOnline(true); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    ping();
    const interval = setInterval(ping, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return <OfflineContext.Provider value={{ online }}>{children}</OfflineContext.Provider>;
}
