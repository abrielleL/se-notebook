import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Drawer from './Drawer.jsx';
import Icon from './Icons.jsx';
import { api } from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { formatDate } from '../lib/stage.js';
import { linkedInSearchUrl, looksLikeLinkedInUrl } from '../lib/linkedin.js';
import { ROLE_OPTIONS, ROLE_BADGES, CONTACT_TYPES, CONTACT_TYPE_OPTIONS } from '../lib/constants.js';

const FIELD = 'bg-[#0a0d11] border border-border rounded px-2 py-1.5 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50 w-full';
const LABEL = 'text-[10px] uppercase tracking-wide text-text-dim mb-1';

export function ContactTypeBadge({ type }) {
  const t = CONTACT_TYPES[type] || CONTACT_TYPES.customer;
  return (
    <span
      className="text-[9px] px-1.5 py-0.5 rounded border font-medium shrink-0"
      style={{ color: t.color, borderColor: `${t.color}55`, background: `${t.color}18` }}
      title={t.label}
    >
      {t.label}
    </span>
  );
}

export function RoleBadge({ role }) {
  const b = ROLE_BADGES[role];
  if (!b) return null;
  const label = (ROLE_OPTIONS.find(o => o.value === role) || {}).label || role;
  return (
    <span
      className="text-[9px] px-1.5 py-0.5 rounded border font-medium shrink-0"
      style={{ color: b.color, borderColor: `${b.color}55`, background: `${b.color}18` }}
      title={label}
    >
      {b.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Contact detail: identity fields, the accounts this person is tied to (with a
// per-account role), and a notes timeline.
// ---------------------------------------------------------------------------
export default function ContactDrawer({ contactId, accounts = [], onClose, onChange }) {
  const toast = useToast();
  const [contact, setContact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [noteBody, setNoteBody] = useState('');
  const [noteAccount, setNoteAccount] = useState('');
  const [linkAccountId, setLinkAccountId] = useState('');
  const [linkRole, setLinkRole] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingNote, setEditingNote] = useState(null);
  const [editingBody, setEditingBody] = useState('');
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);

  const load = () => {
    setLoading(true);
    api.getContact(contactId)
      .then(c => {
        setContact(c);
        setForm({
          name: c.name || '',
          title: c.title || '',
          email: c.email || '',
          phone: c.phone || '',
          org_name: c.org_name || '',
          contact_type: c.contact_type || 'customer',
          linkedin_url: c.linkedin_url || ''
        });
      })
      .catch(() => toast('Failed to load contact', 'error'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [contactId]);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function save() {
    if (!form.name.trim()) return toast('Name is required', 'error');
    setSaving(true);
    try {
      const updated = await api.updateContact(contactId, form);
      setContact(updated);
      toast('Contact saved', 'success');
      onChange?.();
    } catch (e) {
      toast(e.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function addLink() {
    if (!linkAccountId) return;
    try {
      const updated = await api.linkContactAccount(contactId, {
        account_id: linkAccountId,
        role: linkRole || null
      });
      setContact(updated);
      setLinkAccountId('');
      setLinkRole('');
      toast('Account linked', 'success');
      onChange?.();
    } catch (e) {
      toast(e.message || 'Link failed', 'error');
    }
  }

  async function setLinkRoleFor(accountId, role) {
    try {
      const updated = await api.updateContactAccount(contactId, accountId, { role: role || null });
      setContact(updated);
      onChange?.();
    } catch (e) {
      toast(e.message || 'Update failed', 'error');
    }
  }

  async function removeLink(accountId) {
    try {
      const updated = await api.unlinkContactAccount(contactId, accountId);
      if (updated && updated.deleted) { onChange?.(); onClose?.(); return; }
      setContact(updated);
      toast('Account unlinked', 'success');
      onChange?.();
    } catch (e) {
      toast(e.message || 'Unlink failed', 'error');
    }
  }

  async function addNote() {
    const body = noteBody.trim();
    if (!body) return;
    try {
      await api.createContactNote(contactId, { body, account_id: noteAccount || null });
      setNoteBody('');
      setNoteAccount('');
      load();
      onChange?.();
    } catch (e) {
      toast(e.message || 'Could not add note', 'error');
    }
  }

  async function saveNote(noteId) {
    const body = editingBody.trim();
    if (!body) return;
    try {
      await api.updateContactNote(contactId, noteId, { body });
      setEditingNote(null);
      load();
    } catch (e) {
      toast(e.message || 'Could not save note', 'error');
    }
  }

  async function removeNote(noteId) {
    try {
      await api.deleteContactNote(contactId, noteId);
      load();
      onChange?.();
    } catch {
      toast('Could not delete note', 'error');
    }
  }

  // Parse pasted profile text into suggestions. Nothing is saved here — the
  // user picks which fields to accept, so a bad parse can't overwrite good data.
  async function parseProfile() {
    const text = pasteText.trim();
    if (!text) return;
    setParsing(true);
    setParsed(null);
    try {
      const r = await api.parseContactProfile(contactId, text);
      setParsed(r);
      if (!Object.keys(r.suggestions || {}).length && !r.summary) {
        toast('Nothing new found in that text', 'warn');
      }
    } catch (e) {
      toast(e.message || 'Could not parse that text', 'error');
    } finally {
      setParsing(false);
    }
  }

  // Accept one suggested field into the form (still requires Save).
  function applySuggestion(field) {
    setForm(f => ({ ...f, [field]: parsed.suggestions[field] }));
    setParsed(p => {
      const next = { ...p, suggestions: { ...p.suggestions } };
      delete next.suggestions[field];
      return next;
    });
  }

  async function applyAllSuggestions() {
    setForm(f => ({ ...f, ...parsed.suggestions }));
    setParsed(p => ({ ...p, suggestions: {} }));
  }

  // Keep the parsed background as a contact note rather than cramming it into
  // a field — it's context, not an attribute.
  async function saveSummaryAsNote() {
    try {
      await api.createContactNote(contactId, { body: parsed.summary });
      setParsed(p => ({ ...p, summary: '' }));
      load();
      onChange?.();
      toast('Saved as a note', 'success');
    } catch (e) {
      toast(e.message || 'Could not save note', 'error');
    }
  }

  async function removeContact() {
    try {
      await api.deleteContact(contactId);
      toast('Contact deleted', 'success');
      onChange?.();
      onClose?.();
    } catch {
      toast('Delete failed', 'error');
    }
  }

  const linkedIds = new Set((contact?.accounts || []).map(a => a.account_id));
  const linkable = accounts.filter(a => !linkedIds.has(a.id));

  return (
    <Drawer
      title={loading ? 'Contact' : (contact?.name || 'Contact')}
      onClose={onClose}
      width={480}
      footer={
        <>
          {confirmDelete ? (
            <div className="flex items-center gap-2 mr-auto text-[11px] text-accent-red">
              Delete {contact?.name}?
              <button onClick={removeContact} className="underline">Yes</button>
              <button onClick={() => setConfirmDelete(false)} className="underline">No</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="mr-auto text-[11px] text-text-dim hover:text-accent-red"
            >
              Delete contact
            </button>
          )}
          <button onClick={onClose} className="px-3 py-1.5 rounded text-[12px] text-text-muted hover:text-text-primary">
            Close
          </button>
          <button
            onClick={save}
            disabled={saving || loading}
            className="px-3 py-1.5 rounded text-[12px] bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {loading || !form ? (
        <div className="text-[12px] text-text-muted py-6 text-center">Loading…</div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* identity */}
          <div className="flex flex-col gap-2.5">
            <div>
              <div className={LABEL}>Name</div>
              <input value={form.name} onChange={set('name')} className={FIELD} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className={LABEL}>Title</div>
                <input value={form.title} onChange={set('title')} placeholder="e.g. CISO" className={FIELD} />
              </div>
              <div>
                <div className={LABEL}>Relationship</div>
                <select value={form.contact_type} onChange={set('contact_type')} className={FIELD}>
                  {CONTACT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <div className={LABEL}>
                Organization
                {form.contact_type !== 'customer' && (
                  <span className="normal-case tracking-normal text-text-dim"> — their employer, not the account</span>
                )}
              </div>
              <input value={form.org_name} onChange={set('org_name')} placeholder="e.g. Guidepoint Security" className={FIELD} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className={LABEL}>Email</div>
                <input value={form.email} onChange={set('email')} className={FIELD} />
              </div>
              <div>
                <div className={LABEL}>Phone</div>
                <input value={form.phone} onChange={set('phone')} className={FIELD} />
              </div>
            </div>
            {contact.auto_extracted ? (
              <div className="text-[10px] text-text-dim flex items-center gap-1.5">
                <Icon.Sparkles width={10} height={10} />
                Auto-extracted from notes or a transcript — worth a quick check.
              </div>
            ) : null}
          </div>

          {/* ---------------------------------------------------------------
              LinkedIn. We only store a link and open it in the user's own
              browser; LinkedIn has no API that returns another member's
              profile, so there is nothing to fetch automatically.
             --------------------------------------------------------------- */}
          <div>
            <div className="text-[11px] font-semibold text-text-primary mb-2">LinkedIn</div>

            <div className="flex items-center gap-1.5 mb-1.5">
              <input
                value={form.linkedin_url}
                onChange={set('linkedin_url')}
                placeholder="Paste their profile URL"
                className={FIELD}
              />
              {form.linkedin_url ? (
                <a
                  href={form.linkedin_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="px-2 py-1.5 rounded text-[11px] bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25 shrink-0"
                  title="Open profile"
                >
                  Open
                </a>
              ) : (
                <a
                  href={linkedInSearchUrl(contact) || '#'}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={`px-2 py-1.5 rounded text-[11px] border shrink-0 ${
                    linkedInSearchUrl(contact)
                      ? 'bg-card text-text-muted border-border hover:text-text-primary'
                      : 'opacity-40 pointer-events-none bg-card text-text-dim border-border'
                  }`}
                  title="Search LinkedIn for this person"
                >
                  Find
                </a>
              )}
            </div>
            {!looksLikeLinkedInUrl(form.linkedin_url) && (
              <div className="text-[10px] text-accent-red mb-1.5">
                That doesn't look like a linkedin.com URL.
              </div>
            )}

            {!pasting ? (
              <button
                onClick={() => { setPasting(true); setParsed(null); }}
                className="text-[10px] text-text-dim hover:text-accent-blue"
              >
                Paste profile text to fill in title, employer, and background →
              </button>
            ) : (
              <div className="border border-border rounded p-2 bg-[#10141b] flex flex-col gap-1.5">
                <div className="text-[10px] text-text-muted">
                  Open their profile, select the page, and paste it here. Nothing is
                  fetched from LinkedIn — this only reads what you paste.
                </div>
                <textarea
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  rows={4}
                  placeholder="Paste the profile text…"
                  className={FIELD + ' resize-y'}
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={parseProfile}
                    disabled={parsing || !pasteText.trim()}
                    className="px-2 py-1 rounded text-[11px] bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25 disabled:opacity-40"
                  >
                    {parsing ? 'Reading…' : 'Read profile'}
                  </button>
                  <button
                    onClick={() => { setPasting(false); setPasteText(''); setParsed(null); }}
                    className="text-[10px] text-text-muted hover:text-text-primary"
                  >
                    Cancel
                  </button>
                </div>

                {parsed && (
                  <div className="flex flex-col gap-1.5 mt-1">
                    {Object.keys(parsed.suggestions || {}).length > 0 && (
                      <>
                        <div className="flex items-center gap-2">
                          <div className="text-[10px] uppercase tracking-wide text-text-dim">Suggested</div>
                          <button onClick={applyAllSuggestions} className="text-[10px] text-accent-blue hover:underline ml-auto">
                            Accept all
                          </button>
                        </div>
                        {Object.entries(parsed.suggestions).map(([field, value]) => (
                          <div key={field} className="flex items-start gap-2 px-2 py-1.5 bg-card border border-border rounded">
                            <div className="min-w-0 flex-1">
                              <div className="text-[9px] uppercase tracking-wide text-text-dim">
                                {field.replace(/_/g, ' ')}
                              </div>
                              <div className="text-[11px] text-text-primary break-words">{value}</div>
                              {parsed.current?.[field] ? (
                                <div className="text-[9px] text-text-dim break-words">
                                  replaces: {parsed.current[field]}
                                </div>
                              ) : null}
                            </div>
                            <button
                              onClick={() => applySuggestion(field)}
                              className="text-[10px] text-accent-blue hover:underline shrink-0"
                            >
                              Use
                            </button>
                          </div>
                        ))}
                        <div className="text-[9px] text-text-dim">
                          Accepted values land in the fields above — press Save to keep them.
                        </div>
                      </>
                    )}

                    {parsed.summary ? (
                      <div className="px-2 py-1.5 bg-card border border-border rounded">
                        <div className="text-[9px] uppercase tracking-wide text-text-dim mb-0.5">Background</div>
                        <div className="text-[11px] text-text-secondary break-words">{parsed.summary}</div>
                        <button
                          onClick={saveSummaryAsNote}
                          className="text-[10px] text-accent-blue hover:underline mt-1"
                        >
                          Save as a note
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* accounts */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] font-semibold text-text-primary">
                Accounts
                <span className="text-text-dim font-normal"> · {(contact.accounts || []).length}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              {(contact.accounts || []).map(a => (
                <div key={a.account_id} className="flex items-center gap-2 px-2 py-1.5 bg-[#10141b] border border-border rounded">
                  <Link
                    to={`/accounts/${a.account_id}`}
                    className="text-[11px] text-accent-blue hover:underline truncate flex-1 min-w-0"
                  >
                    {a.account_name}
                  </Link>
                  {a.is_primary ? (
                    <span className="text-[9px] text-text-dim shrink-0" title="Primary account">primary</span>
                  ) : null}
                  <select
                    value={a.role || ''}
                    onChange={e => setLinkRoleFor(a.account_id, e.target.value)}
                    className="bg-[#0a0d11] border border-border rounded px-1.5 py-0.5 text-[10px] text-text-muted focus:outline-none focus:border-accent-blue/50 shrink-0"
                  >
                    {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <button
                    onClick={() => removeLink(a.account_id)}
                    className="text-text-dim hover:text-accent-red shrink-0"
                    title="Unlink from this account"
                  >
                    <Icon.X width={11} height={11} />
                  </button>
                </div>
              ))}
              {!(contact.accounts || []).length && (
                <div className="text-[10px] text-text-dim">Not tied to any account yet.</div>
              )}
            </div>

            {linkable.length > 0 && (
              <div className="flex items-center gap-1.5 mt-2">
                <select
                  value={linkAccountId}
                  onChange={e => setLinkAccountId(e.target.value)}
                  className="bg-[#0a0d11] border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/50 flex-1 min-w-0"
                >
                  <option value="">Link to another account…</option>
                  {linkable.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
                </select>
                <select
                  value={linkRole}
                  onChange={e => setLinkRole(e.target.value)}
                  className="bg-[#0a0d11] border border-border rounded px-2 py-1 text-[11px] text-text-muted focus:outline-none focus:border-accent-blue/50 shrink-0"
                >
                  {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button
                  onClick={addLink}
                  disabled={!linkAccountId}
                  className="px-2 py-1 rounded text-[11px] bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25 disabled:opacity-40 shrink-0"
                >
                  Link
                </button>
              </div>
            )}
          </div>

          {/* notes */}
          <div>
            <div className="text-[11px] font-semibold text-text-primary mb-2">
              Notes
              <span className="text-text-dim font-normal"> · {(contact.notes || []).length}</span>
            </div>

            <div className="flex flex-col gap-1.5 mb-2">
              <textarea
                value={noteBody}
                onChange={e => setNoteBody(e.target.value)}
                placeholder="What did you learn about this person?"
                rows={2}
                className={FIELD + ' resize-y'}
              />
              <div className="flex items-center gap-1.5">
                <select
                  value={noteAccount}
                  onChange={e => setNoteAccount(e.target.value)}
                  className="bg-[#0a0d11] border border-border rounded px-2 py-1 text-[11px] text-text-muted focus:outline-none focus:border-accent-blue/50 flex-1 min-w-0"
                >
                  <option value="">General (no account)</option>
                  {(contact.accounts || []).map(a => (
                    <option key={a.account_id} value={a.account_id}>{a.account_name}</option>
                  ))}
                </select>
                <button
                  onClick={addNote}
                  disabled={!noteBody.trim()}
                  className="px-2 py-1 rounded text-[11px] bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25 disabled:opacity-40 shrink-0"
                >
                  Add note
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              {(contact.notes || []).map(n => (
                <div key={n.id} className="px-2.5 py-2 bg-[#10141b] border border-border rounded">
                  {editingNote === n.id ? (
                    <>
                      <textarea
                        value={editingBody}
                        onChange={e => setEditingBody(e.target.value)}
                        rows={3}
                        className={FIELD + ' resize-y mb-1.5'}
                      />
                      <div className="flex items-center gap-2 text-[10px]">
                        <button onClick={() => saveNote(n.id)} className="text-accent-blue hover:underline">Save</button>
                        <button onClick={() => setEditingNote(null)} className="text-text-dim hover:text-text-primary">Cancel</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-[11px] text-text-primary whitespace-pre-wrap break-words">{n.body}</div>
                      <div className="flex items-center gap-2 mt-1.5 text-[9px] text-text-dim">
                        <span>{n.account_name || 'General'}</span>
                        <span>·</span>
                        <span>{formatDate(n.created_at)}</span>
                        <button
                          onClick={() => { setEditingNote(n.id); setEditingBody(n.body); }}
                          className="ml-auto hover:text-accent-blue"
                        >
                          Edit
                        </button>
                        <button onClick={() => removeNote(n.id)} className="hover:text-accent-red">Delete</button>
                      </div>
                    </>
                  )}
                </div>
              ))}
              {!(contact.notes || []).length && (
                <div className="text-[10px] text-text-dim">No notes yet.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
