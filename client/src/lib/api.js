async function request(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

const json = (body) => JSON.stringify(body);

// Forward the browser-held Anthropic key to server-side AI routes. The key
// lives only in localStorage and is sent transiently per request; the server
// never stores it.
function aiHeaders() {
  const key = localStorage.getItem('anthropic_api_key') || '';
  return { 'Content-Type': 'application/json', 'x-anthropic-key': key };
}

export const api = {
  // accounts
  listAccounts: () => request('/api/accounts'),
  getAccount: (id) => request(`/api/accounts/${id}`),
  createAccount: (body) => request('/api/accounts', { method: 'POST', body: json(body) }),
  updateAccount: (id, body) => request(`/api/accounts/${id}`, { method: 'PUT', body: json(body) }),

  // notes
  listNotes: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/notes${q ? `?${q}` : ''}`);
  },
  getNote: (id) => request(`/api/notes/${id}`),
  createNote: (body) => request('/api/notes', { method: 'POST', body: json(body) }),
  updateNote: (id, body) => request(`/api/notes/${id}`, { method: 'PUT', body: json(body) }),
  deleteNote: (id) => request(`/api/notes/${id}`, { method: 'DELETE' }),
  restoreNote: (id) => request(`/api/notes/${id}/restore`, { method: 'POST' }),
  noteVersions: (id) => request(`/api/notes/${id}/versions`),

  // contacts
  listContacts: (params = {}) => {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null));
    const q = new URLSearchParams(clean).toString();
    return request(`/api/contacts${q ? `?${q}` : ''}`);
  },
  contactStats: () => request('/api/contacts/stats'),
  getContact: (id) => request(`/api/contacts/${id}`),
  createContact: (body) => request('/api/contacts', { method: 'POST', body: json(body) }),
  updateContact: (id, body) => request(`/api/contacts/${id}`, { method: 'PUT', body: json(body) }),
  deleteContact: (id) => request(`/api/contacts/${id}`, { method: 'DELETE' }),

  // contact <-> account links (a partner can be tied to several accounts)
  linkContactAccount: (id, body) =>
    request(`/api/contacts/${id}/accounts`, { method: 'POST', body: json(body) }),
  updateContactAccount: (id, accountId, body) =>
    request(`/api/contacts/${id}/accounts/${accountId}`, { method: 'PUT', body: json(body) }),
  unlinkContactAccount: (id, accountId) =>
    request(`/api/contacts/${id}/accounts/${accountId}`, { method: 'DELETE' }),

  // notes about a person
  createContactNote: (id, body) =>
    request(`/api/contacts/${id}/notes`, { method: 'POST', body: json(body) }),
  updateContactNote: (id, noteId, body) =>
    request(`/api/contacts/${id}/notes/${noteId}`, { method: 'PUT', body: json(body) }),
  deleteContactNote: (id, noteId) =>
    request(`/api/contacts/${id}/notes/${noteId}`, { method: 'DELETE' }),

  // duplicate review queue
  contactMergeCandidates: () => request('/api/contacts/merge-candidates'),
  dismissMergeCandidate: (id) =>
    request(`/api/contacts/merge-candidates/${id}/dismiss`, { method: 'POST' }),
  mergeContacts: (keeperId, loserId) =>
    request('/api/contacts/merge', { method: 'POST', body: json({ keeper_id: keeperId, loser_id: loserId }) }),

  // next steps
  listNextSteps: (accountId) => request(`/api/next-steps/${accountId}`),
  createNextStep: (body) => request('/api/next-steps', { method: 'POST', body: json(body) }),
  updateNextStep: (id, body) => request(`/api/next-steps/${id}`, { method: 'PUT', body: json(body) }),
  deleteNextStep: (id) => request(`/api/next-steps/${id}`, { method: 'DELETE' }),

  // todos
  listTodos: (accountId) => request(`/api/todos/${accountId}`),
  createTodo: (body) => request('/api/todos', { method: 'POST', body: json(body) }),
  updateTodo: (id, body) => request(`/api/todos/${id}`, { method: 'PUT', body: json(body) }),
  deleteTodo: (id) => request(`/api/todos/${id}`, { method: 'DELETE' }),

  // transcripts
  uploadTranscript: (form) => request('/api/transcripts', { method: 'POST', body: form }),
  deleteTranscript: (id) => request(`/api/transcripts/${id}`, { method: 'DELETE' }),

  // attachments
  uploadAttachment: (form) => request('/api/attachments', { method: 'POST', body: form }),
  deleteAttachment: (id) => request(`/api/attachments/${id}`, { method: 'DELETE' }),

  // meetings
  listMeetings: (accountId) => request(`/api/meetings/${accountId}`),
  syncMeetings: (accountId) => request(`/api/meetings/sync/${accountId}`, { method: 'POST' }),
  updateMeeting: (id, body) => request(`/api/meetings/${id}`, { method: 'PUT', body: json(body) }),

  // search & dashboard
  search: (q) => request(`/api/search?q=${encodeURIComponent(q)}`),
  dashboard: () => request('/api/dashboard'),

  // microsoft auth
  msStatus: () => request('/api/auth/microsoft/status'),
  msDisconnect: () => request('/api/auth/microsoft/disconnect', { method: 'POST' }),

  // crm snapshots
  listCrmSnapshots: (accountId) => request(`/api/accounts/${accountId}/crm-snapshots`),
  createCrmSnapshot: (accountId, body) => request(`/api/accounts/${accountId}/crm-snapshots`, { method: 'POST', body: json(body) }),
  deleteCrmSnapshot: (id) => request(`/api/crm-snapshots/${id}`, { method: 'DELETE' }),

  // deal intelligence (account qualification)
  getDealIntelligence: (accountId) => request(`/api/accounts/${accountId}/deal-intelligence`),
  updateDealIntelligence: (accountId, field, body) =>
    request(`/api/accounts/${accountId}/deal-intelligence/${field}`, { method: 'PUT', body: json(body) }),

  // stage gates
  getStageGates: (accountId, stage) => request(`/api/accounts/${accountId}/stage-gates/${encodeURIComponent(stage)}`),
  updateStageGate: (accountId, stage, gateKey, completed) =>
    request(`/api/accounts/${accountId}/stage-gates/${encodeURIComponent(stage)}/${encodeURIComponent(gateKey)}`,
      { method: 'PUT', body: json({ completed }) }),

  // account tags (managed catalog)
  listTags: () => request('/api/tags'),
  createTag: (body) => request('/api/tags', { method: 'POST', body: json(body) }),
  updateTag: (id, body) => request(`/api/tags/${id}`, { method: 'PUT', body: json(body) }),
  deleteTag: (id) => request(`/api/tags/${id}`, { method: 'DELETE' }),

  // pov config
  getPovConfig: () => request('/api/pov-config'),
  createPovConfig: (body) => request('/api/pov-config', { method: 'POST', body: json(body) }),
  updatePovConfig: (id, body) => request(`/api/pov-config/${id}`, { method: 'PUT', body: json(body) }),
  deletePovConfig: (id) => request(`/api/pov-config/${id}`, { method: 'DELETE' }),

  // POV drafts (AI routes forward the key)
  listPov: (accountId) => request(`/api/accounts/${accountId}/pov`),
  generatePov: (accountId, body) =>
    request(`/api/accounts/${accountId}/pov`, { method: 'POST', headers: aiHeaders(), body: json(body) }),
  povJob: (jobId) => request(`/api/pov-jobs/${jobId}`),
  updatePovSection: (accountId, povId, sectionKey, body) =>
    request(`/api/accounts/${accountId}/pov/${povId}/section/${encodeURIComponent(sectionKey)}`,
      { method: 'PUT', body: json(body) }),
  regeneratePovSection: (accountId, povId, sectionKey, body) =>
    request(`/api/accounts/${accountId}/pov/${povId}/section/${encodeURIComponent(sectionKey)}/regenerate`,
      { method: 'POST', headers: aiHeaders(), body: json(body) }),
  updatePov: (accountId, povId, body) =>
    request(`/api/accounts/${accountId}/pov/${povId}`, { method: 'PUT', body: json(body) }),
  deletePovDraft: (id) => request(`/api/pov-drafts/${id}`, { method: 'DELETE' }),
  povRevisions: (id) => request(`/api/pov-drafts/${id}/revisions`),

  // server-side AI extraction (deal intel + contacts)
  runExtraction: (accountId, body = {}) =>
    request(`/api/accounts/${accountId}/run-extraction`, { method: 'POST', headers: aiHeaders(), body: json(body) }),

  // email draft
  emailDraft: (accountId, body) =>
    request(`/api/accounts/${accountId}/email-draft`, { method: 'POST', headers: aiHeaders(), body: json(body) }),

  // export (pov_id optional — targets a specific POV draft, else the latest)
  // kind: 'account' (full selectable summary) or 'pov' (fixed branded POV doc)
  // opts.includeNonCustomerContacts adds partner/analyst/internal people to the
  // Contacts section; off by default so they stay out of customer deliverables.
  exportPdf: (accountId, sections, povId, kind = 'account', opts = {}) =>
    request(`/api/accounts/${accountId}/export`, {
      method: 'POST',
      body: json({
        format: 'pdf', sections, pov_id: povId, kind,
        include_non_customer_contacts: Boolean(opts.includeNonCustomerContacts)
      })
    }),
  exportDocx: async (accountId, sections, povId, kind = 'account', opts = {}) => {
    const res = await fetch(`/api/accounts/${accountId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json({
        format: 'docx', sections, pov_id: povId, kind,
        include_non_customer_contacts: Boolean(opts.includeNonCustomerContacts)
      })
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    return { blob, filename: match ? match[1] : 'export.docx' };
  },

  // account files
  listAllFiles: () => request('/api/files'),
  listFiles: (accountId) => request(`/api/accounts/${accountId}/files`),
  deleteFile: (id) => request(`/api/files/${id}`, { method: 'DELETE' }),
  fileDownloadUrl: (id) => `/api/files/${id}/download`,
  uploadFile: (accountId, formData, onProgress) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/accounts/${accountId}/files`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve(null); }
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(formData);
  }),

  // pov timeline (calendar)
  listTimelines: () => request('/api/pov-timeline'),
  createTimeline: (body) => request('/api/pov-timeline', { method: 'POST', body: json(body) }),
  updateTimeline: (id, body) => request(`/api/pov-timeline/${id}`, { method: 'PUT', body: json(body) }),
  deleteTimeline: (id) => request(`/api/pov-timeline/${id}`, { method: 'DELETE' }),

  // pov meetings (scoping/kickoff/check-in/wrap-up dates on a timeline)
  addPovMeeting: (body) => request('/api/pov-meetings', { method: 'POST', body: json(body) }),
  deletePovMeeting: (id) => request(`/api/pov-meetings/${id}`, { method: 'DELETE' })
};
