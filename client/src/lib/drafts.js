import { useEffect, useState } from 'react';

// Client-side store for in-progress (unsaved) notes. Drafts live in
// localStorage so they survive navigation and reloads; each editor writes its
// draft as you type and removes it once the note is actually saved.
//
// Draft shape: { id, source, accountId, accountName, text, payload, updatedAt }
//   source   — 'new-note' | 'quick-capture'
//   text     — the note body, used for the list snippet
//   payload  — full editor state needed to resume (form / fields)

const KEY = 'se_note_drafts_v1';
const EVENT = 'drafts-changed';

function read() {
  try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function write(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(EVENT));
}

export function listDrafts() {
  return read().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export function getDraft(id) {
  return read().find(d => d.id === id) || null;
}
export function upsertDraft(draft) {
  const list = read();
  const i = list.findIndex(d => d.id === draft.id);
  const next = { ...draft, updatedAt: Date.now() };
  if (i >= 0) list[i] = next; else list.push(next);
  write(list);
  return next;
}
export function deleteDraft(id) {
  write(read().filter(d => d.id !== id));
}
export function newDraftId() {
  return 'd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Live list of drafts that re-renders on any change (this tab or another).
export function useDrafts() {
  const [drafts, setDrafts] = useState(listDrafts);
  useEffect(() => {
    const h = () => setDrafts(listDrafts());
    window.addEventListener(EVENT, h);
    window.addEventListener('storage', h);
    return () => { window.removeEventListener(EVENT, h); window.removeEventListener('storage', h); };
  }, []);
  return drafts;
}
