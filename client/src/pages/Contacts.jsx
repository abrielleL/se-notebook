import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import Icon from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import ContactDrawer, { ContactTypeBadge, RoleBadge } from '../components/ContactDrawer.jsx';
import { initials, colorForName, formatDate } from '../lib/stage.js';
import { linkedInSearchUrl } from '../lib/linkedin.js';
import {
  CONTACT_TYPES, CONTACT_TYPE_OPTIONS, ROLE_OPTIONS, DUPE_REASONS
} from '../lib/constants.js';

const FIELD = 'bg-[#040d1c] border border-border rounded px-2 py-1.5 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50';

const SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'org', label: 'Organization' },
  { value: 'accounts', label: 'Most accounts' },
  { value: 'recent', label: 'Recently noted' },
  { value: 'created', label: 'Newest' }
];

const emptyForm = () => ({
  name: '', title: '', org_name: '', email: '', phone: '',
  contact_type: 'customer', account_id: '', meddpicc_role: ''
});

// ---------------------------------------------------------------------------
// Duplicate review. The migration auto-merged only the unambiguous cases; the
// judgment calls land here so a wrong guess never silently combines two people.
// ---------------------------------------------------------------------------
function DuplicateReview({ candidates, onResolved, onOpen }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);

  async function merge(cand, keeper, loser) {
    setBusy(cand.id);
    try {
      await api.mergeContacts(keeper.id, loser.id);
      toast(`Merged into ${keeper.name}`, 'success');
      onResolved();
    } catch (e) {
      toast(e.message || 'Merge failed', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(cand) {
    setBusy(cand.id);
    try {
      await api.dismissMergeCandidate(cand.id);
      onResolved();
    } catch (e) {
      toast(e.message || 'Could not dismiss', 'error');
    } finally {
      setBusy(null);
    }
  }

  const Side = ({ c, other, cand }) => (
    <div className="flex-1 min-w-0 px-2.5 py-2 bg-[#111f42] border border-border rounded">
      <button
        onClick={() => onOpen(c.id)}
        className="text-[12px] text-text-primary hover:text-accent-blue truncate block text-left w-full"
      >
        {c.name}
      </button>
      <div className="text-[10px] text-text-muted truncate">
        {c.title || 'no title'}
        {c.org_name ? ` · ${c.org_name}` : ''}
      </div>
      <div className="text-[10px] text-text-dim mt-0.5">
        {c.account_count} account{c.account_count === 1 ? '' : 's'} · {c.note_count} note{c.note_count === 1 ? '' : 's'}
        {c.auto_extracted ? ' · auto-extracted' : ''}
      </div>
      <button
        onClick={() => merge(cand, c, other)}
        disabled={busy === cand.id}
        className="mt-1.5 w-full px-2 py-1 rounded text-[10px] bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25 disabled:opacity-40"
      >
        Keep this one
      </button>
    </div>
  );

  return (
    <div className="mb-5 border border-accent-yellow/30 bg-[#2e1d18]/20 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon.Sparkles width={13} height={13} />
        <div className="text-[13px] font-semibold text-text-primary">
          Possible duplicates
          <span className="text-text-dim font-normal"> · {candidates.length}</span>
        </div>
      </div>
      <div className="text-[11px] text-text-muted mb-3">
        These pairs looked like the same person but were too ambiguous to merge automatically.
        Keeping one moves the other's accounts and notes across before deleting it.
      </div>
      <div className="flex flex-col gap-2">
        {candidates.map(cand => (
          <div key={cand.id} className="bg-card border border-border rounded p-2.5">
            <div className="flex items-center gap-2 mb-2 text-[10px]">
              <span className="px-1.5 py-0.5 rounded bg-[#111f42] border border-border text-text-muted">
                {DUPE_REASONS[cand.reason] || cand.reason}
              </span>
              {cand.account_name && (
                <Link to={`/accounts/${cand.account_id}`} className="text-accent-blue hover:underline truncate">
                  {cand.account_name}
                </Link>
              )}
              <button
                onClick={() => dismiss(cand)}
                disabled={busy === cand.id}
                className="ml-auto text-text-dim hover:text-text-primary shrink-0"
              >
                Not the same person
              </button>
            </div>
            <div className="flex items-stretch gap-2">
              <Side c={cand.a} other={cand.b} cand={cand} />
              <div className="flex items-center text-[10px] text-text-dim shrink-0">vs</div>
              <Side c={cand.b} other={cand.a} cand={cand} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contact directory
// ---------------------------------------------------------------------------
export default function Contacts() {
  const toast = useToast();
  const [contacts, setContacts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [acctFilter, setAcctFilter] = useState('');
  const [sort, setSort] = useState('name');

  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [showDupes, setShowDupes] = useState(true);

  const loadContacts = () => api.listContacts({
    q: query, type: typeFilter, role: roleFilter, account_id: acctFilter, sort
  }).then(setContacts);

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      loadContacts(),
      api.listAccounts().then(setAccounts),
      api.contactMergeCandidates().then(setCandidates).catch(() => setCandidates([])),
      api.contactStats().then(setStats).catch(() => setStats(null))
    ]).catch(() => toast('Failed to load contacts', 'error'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadAll(); }, []);

  // Re-query the server whenever a filter changes; the directory can grow past
  // what's sensible to filter client-side.
  useEffect(() => {
    const t = setTimeout(() => { loadContacts().catch(() => {}); }, 180);
    return () => clearTimeout(t);
  }, [query, typeFilter, roleFilter, acctFilter, sort]);

  const refresh = () => {
    loadContacts().catch(() => {});
    api.contactMergeCandidates().then(setCandidates).catch(() => {});
    api.contactStats().then(setStats).catch(() => {});
  };

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function create() {
    if (!form.name.trim()) return toast('Name is required', 'error');
    try {
      const created = await api.createContact({
        ...form,
        account_id: form.account_id || null,
        meddpicc_role: form.meddpicc_role || null
      });
      setForm(emptyForm());
      setAdding(false);
      refresh();
      if (created._merged_into_existing) {
        toast(`${created.name} already existed — updated instead of duplicating`, 'success');
      } else {
        toast('Contact added', 'success');
      }
      setOpenId(created.id);
    } catch (e) {
      toast(e.message || 'Could not add contact', 'error');
    }
  }

  const accountsById = useMemo(
    () => Object.fromEntries(accounts.map(a => [a.id, a])),
    [accounts]
  );

  const typeCounts = useMemo(() => {
    const m = {};
    (stats?.by_type || []).forEach(t => { m[t.type] = t.n; });
    return m;
  }, [stats]);

  const activeFilters = query || typeFilter || roleFilter || acctFilter;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Contact Directory</h1>
          <div className="text-[12px] text-text-muted mt-1">
            {stats ? `${stats.total} people` : `${contacts.length} people`}
            {stats?.multi_account ? ` · ${stats.multi_account} tied to more than one account` : ''}
            {activeFilters ? ` · ${contacts.length} shown` : ''}
          </div>
        </div>
        <button
          onClick={() => setAdding(a => !a)}
          className="flex items-center gap-1.5 bg-accent-blue/15 hover:bg-accent-blue/25 text-accent-blue border border-accent-blue/30 rounded px-3 py-1.5 text-[12px] font-medium transition"
        >
          <Icon.Plus width={12} height={12} /> Add contact
        </button>
      </div>

      {adding && (
        <div className="mb-5 bg-card border border-border rounded-lg p-4">
          <div className="text-[12px] font-semibold text-text-primary mb-3">New contact</div>
          <div className="grid grid-cols-3 gap-2 mb-2">
            <input placeholder="Full name" value={form.name} onChange={set('name')} className={FIELD} autoFocus />
            <input placeholder="Title" value={form.title} onChange={set('title')} className={FIELD} />
            <select value={form.contact_type} onChange={set('contact_type')} className={FIELD}>
              {CONTACT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-2">
            <input
              placeholder={form.contact_type === 'customer' ? 'Organization (optional)' : 'Organization — their employer'}
              value={form.org_name} onChange={set('org_name')} className={FIELD}
            />
            <input placeholder="Email" value={form.email} onChange={set('email')} className={FIELD} />
            <input placeholder="Phone" value={form.phone} onChange={set('phone')} className={FIELD} />
          </div>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <select value={form.account_id} onChange={set('account_id')} className={FIELD}>
              <option value="">No account yet</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
            </select>
            <select value={form.meddpicc_role} onChange={set('meddpicc_role')} className={FIELD} disabled={!form.account_id}>
              {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="text-[10px] text-text-dim mb-3">
            You can tie this person to more accounts after saving — useful for partners who span several deals.
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={create}
              className="px-3 py-1.5 rounded text-[12px] bg-accent-blue/15 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/25"
            >
              Save contact
            </button>
            <button
              onClick={() => { setAdding(false); setForm(emptyForm()); }}
              className="px-3 py-1.5 rounded text-[12px] text-text-muted hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {candidates.length > 0 && showDupes && (
        <DuplicateReview
          candidates={candidates}
          onResolved={refresh}
          onOpen={setOpenId}
        />
      )}
      {candidates.length > 0 && (
        <button
          onClick={() => setShowDupes(s => !s)}
          className="text-[11px] text-text-dim hover:text-text-primary mb-4"
        >
          {showDupes ? 'Hide' : `Show ${candidates.length}`} possible duplicate{candidates.length === 1 ? '' : 's'}
        </button>
      )}

      <input
        type="text"
        placeholder="Search by name, title, email, or organization"
        value={query}
        onChange={e => setQuery(e.target.value)}
        className="w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50 mb-3"
      />

      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        <button
          onClick={() => setTypeFilter('')}
          className={`px-2.5 py-1 rounded text-[11px] border transition ${
            !typeFilter ? 'bg-accent-blue/15 text-accent-blue border-accent-blue/30' : 'bg-card text-text-muted border-border hover:text-text-primary'
          }`}
        >
          Everyone
        </button>
        {Object.entries(CONTACT_TYPES).map(([value, t]) => (
          <button
            key={value}
            onClick={() => setTypeFilter(value)}
            className={`px-2.5 py-1 rounded text-[11px] border transition ${
              typeFilter === value ? 'bg-accent-blue/15 text-accent-blue border-accent-blue/30' : 'bg-card text-text-muted border-border hover:text-text-primary'
            }`}
          >
            {t.label}{typeCounts[value] ? ` · ${typeCounts[value]}` : ''}
          </button>
        ))}

        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}
          className="ml-auto bg-card border border-border rounded px-2 py-1 text-[11px] text-text-muted focus:outline-none focus:border-accent-blue/50">
          <option value="">Any role</option>
          {ROLE_OPTIONS.filter(o => o.value).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={acctFilter} onChange={e => setAcctFilter(e.target.value)}
          className="bg-card border border-border rounded px-2 py-1 text-[11px] text-text-muted focus:outline-none focus:border-accent-blue/50">
          <option value="">All accounts</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
        </select>
        <select value={sort} onChange={e => setSort(e.target.value)}
          className="bg-card border border-border rounded px-2 py-1 text-[11px] text-text-muted focus:outline-none focus:border-accent-blue/50">
          {SORTS.map(s => <option key={s.value} value={s.value}>Sort: {s.label}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="text-[12px] text-text-muted py-8 text-center">Loading contacts…</div>
      ) : contacts.length === 0 ? (
        <div className="text-center py-12 text-text-dim text-[12px] border border-dashed border-border rounded-lg">
          {activeFilters
            ? 'No contacts match your filters.'
            : 'No contacts yet. Add one above, or they will appear as you save notes and transcripts.'}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {contacts.map(c => (
            <div
              key={c.id}
              className="flex items-center bg-card border border-border rounded hover:border-accent-blue/40 transition"
            >
            <button
              onClick={() => setOpenId(c.id)}
              className="flex items-center gap-3 px-3 py-2.5 text-left flex-1 min-w-0"
            >
              <span
                className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-semibold text-white"
                style={{ background: colorForName(c.name) }}
              >
                {initials(c.name)}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-[12px] text-text-primary truncate">{c.name}</span>
                  {c.contact_type && c.contact_type !== 'customer' && <ContactTypeBadge type={c.contact_type} />}
                  {c.roles.slice(0, 2).map((r, i) => <RoleBadge key={`${r}-${i}`} role={r} />)}
                </span>
                <span className="block text-[10px] text-text-muted truncate">
                  {c.title || 'no title'}
                  {c.org_name ? ` · ${c.org_name}` : ''}
                  {c.note_count ? ` · ${c.note_count} note${c.note_count === 1 ? '' : 's'}` : ''}
                  {c.last_touched ? ` · ${formatDate(c.last_touched)}` : ''}
                </span>
              </span>

              <span className="hidden md:flex items-center gap-1 shrink-0 max-w-[45%] justify-end">
                {c.account_ids.slice(0, 3).map((id, i) => (
                  <span
                    key={id}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-[#111f42] text-text-muted border border-border truncate max-w-[130px]"
                    title={c.account_names[i]}
                  >
                    {accountsById[id]?.account_name || c.account_names[i]}
                  </span>
                ))}
                {c.account_count > 3 && (
                  <span className="text-[10px] text-text-dim">+{c.account_count - 3}</span>
                )}
                {c.account_count === 0 && (
                  <span className="text-[10px] text-text-dim italic">no account</span>
                )}
              </span>
            </button>

            {/* Opened in the user's own browser — the notebook never fetches it. */}
            <a
              href={c.linkedin_url || linkedInSearchUrl(c) || '#'}
              target="_blank"
              rel="noreferrer noopener"
              title={c.linkedin_url ? 'Open LinkedIn profile' : 'Search for them on LinkedIn'}
              className={`px-3 py-2.5 shrink-0 ${
                c.linkedin_url
                  ? 'text-accent-blue hover:text-accent-blue'
                  : 'text-text-dim hover:text-text-muted'
              }`}
            >
              <Icon.Link width={12} height={12} />
            </a>
            </div>
          ))}
        </div>
      )}

      {openId && (
        <ContactDrawer
          contactId={openId}
          accounts={accounts}
          onClose={() => setOpenId(null)}
          onChange={refresh}
        />
      )}
    </div>
  );
}
