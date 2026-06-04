import { useEffect } from 'react';

// Tiny cross-component bus so an account edit made anywhere (edit modal, stage
// bar) updates other mounted views (accounts list, dashboard) immediately,
// without a full store or a refetch. Views still refetch on mount, so this is
// purely the "update live while already mounted" path.
const EVENT = 'se-account-updated';

export function emitAccountUpdated(account) {
  if (account && account.id) {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: account }));
  }
}

export function useAccountUpdates(handler) {
  useEffect(() => {
    const fn = (e) => handler(e.detail);
    window.addEventListener(EVENT, fn);
    return () => window.removeEventListener(EVENT, fn);
  }, [handler]);
}
