import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Card from '../components/Card.jsx';
import { useToast } from '../components/Toast.jsx';

const FREQUENCIES = [
  { value: 'off', label: 'Off' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' }
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const FIELD = 'bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50';

// Backup destination + schedule.
//
// The schedule is enforced by the host-side runner (the server is in Docker and
// can't reach an arbitrary disk), which ticks every 15 minutes and reads this
// config. So saving here takes effect on its own — there's nothing to reload.
export default function BackupSettings() {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [state, setState] = useState({ status: null, snapshots: [], writableHere: true, total: 0 });
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [dirty, setDirty] = useState(false);

  async function load() {
    try {
      const r = await api.getBackupSettings();
      setForm(r.config);
      setState({ status: r.status, snapshots: r.snapshots || [], writableHere: r.writableHere, total: r.total || 0 });
      setDirty(false);
    } catch (e) {
      toast(`Could not load backup settings: ${e.message}`, 'error');
    }
  }
  useEffect(() => { load(); }, []);

  // Only the numeric fields get coerced. Coercing everything turned
  // frequency into NaN, which JSON-serialised to null and made the server
  // fall back to 'daily' — so hourly/weekly/off could never actually be set.
  const NUMERIC = new Set(['hour', 'minute', 'weekday', 'keep']);
  const set = (k) => (e) => {
    const v = e.target.value;
    setForm(f => ({ ...f, [k]: NUMERIC.has(k) ? Number(v) : v }));
    setDirty(true);
  };

  async function save() {
    setSaving(true);
    try {
      await api.saveBackupSettings(form);
      await load();
      toast('Backup settings saved', 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const r = await api.runBackupNow();
      await load();
      toast(r.queued ? r.message : `Backed up — ${r.status.file}`, r.queued ? 'warn' : 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setRunning(false);
    }
  }

  if (!form) return null;

  const st = state.status;
  const showTime = form.frequency === 'daily' || form.frequency === 'weekly';

  return (
    <Card className="p-6 mt-5">
      <div className="text-[13px] font-medium text-text-primary mb-1">Database backups</div>
      <p className="text-[12px] text-text-muted mb-4 leading-relaxed">
        Snapshots are taken with SQLite's own backup command and verified before they're kept, so
        they're safe to take while you're working. A snapshot that fails verification is discarded
        rather than left looking restorable.
      </p>

      {/* Last run — the thing that actually matters, and the thing that was
          silently broken for 13 days when the DB moved. */}
      <div className={`rounded border px-3 py-2.5 mb-4 text-[12px] ${
        !st ? 'border-border bg-card text-text-dim'
          : st.ok ? 'border-accent-green/30 bg-accent-green/5 text-text-secondary'
            : 'border-accent-red/40 bg-accent-red/5 text-accent-red'
      }`}>
        {!st ? (
          'No backup has run yet.'
        ) : st.ok ? (
          <>
            Last backup <span className="text-text-primary">{timeAgo(st.last_run)}</span>
            {st.accounts != null && <> · {st.accounts} accounts</>}
            {st.file && <> · <span className="font-mono text-[11px]">{st.file}</span></>}
            <div className="text-[11px] text-text-dim mt-0.5">
              {st.path} · taken by {st.by === 'app' ? 'this app' : 'the scheduled job'}
            </div>
          </>
        ) : (
          <>
            Last backup attempt failed{st.last_attempt ? ` ${timeAgo(st.last_attempt)}` : ''}: {st.error}
            {st.last_run && <div className="text-[11px] mt-0.5">Last good backup: {timeAgo(st.last_run)}</div>}
          </>
        )}
      </div>

      <label className="block text-[11px] text-text-muted mb-1">Backup folder</label>
      <input
        value={form.path}
        onChange={set('path')}
        placeholder="~/se-notebook-data/backups"
        className={`${FIELD} w-full font-mono`}
      />
      <p className="text-[11px] text-text-dim mt-1.5 mb-4 leading-relaxed">
        Any absolute path — an external drive, a synced folder, wherever. It's created if it doesn't
        exist. Keeping snapshots on a <em>different</em> disk from the database is what protects you
        from losing both.
        {!state.writableHere && (
          <span className="block text-accent-yellow mt-1">
            This folder is outside the app's container, so the scheduled job writes it and
            “Back up now” runs on the next check (within 15 minutes).
          </span>
        )}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div>
          <label className="block text-[11px] text-text-muted mb-1">Frequency</label>
          <select value={form.frequency} onChange={set('frequency')} className={`${FIELD} w-full`}>
            {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        {form.frequency === 'weekly' && (
          <div>
            <label className="block text-[11px] text-text-muted mb-1">Day</label>
            <select value={form.weekday} onChange={set('weekday')} className={`${FIELD} w-full`}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </div>
        )}
        {showTime && (
          <div>
            <label className="block text-[11px] text-text-muted mb-1">Time</label>
            <div className="flex items-center gap-1">
              <select value={form.hour} onChange={set('hour')} className={`${FIELD} flex-1`}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
              </select>
              <span className="text-text-dim">:</span>
              <select value={form.minute} onChange={set('minute')} className={`${FIELD} flex-1`}>
                {[0, 15, 30, 45].map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
              </select>
            </div>
          </div>
        )}
        <div>
          <label className="block text-[11px] text-text-muted mb-1">Keep</label>
          <select value={form.keep} onChange={set('keep')} className={`${FIELD} w-full`}>
            {[7, 14, 30, 60, 90].map(n => <option key={n} value={n}>{n} snapshots</option>)}
          </select>
        </div>
      </div>

      <p className="text-[11px] text-text-dim mb-4">
        {form.frequency === 'off'
          ? 'Automatic backups are off. Nothing will be taken unless you use the button below.'
          : `${describe(form)} · the ${form.keep} most recent snapshots are kept, older ones deleted.`}
        {form.frequency !== 'off' &&
          ' A window missed because the Mac was asleep is caught on the next check rather than skipped.'}
      </p>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="bg-accent-blue/15 hover:bg-accent-blue/25 text-accent-blue border border-accent-blue/30 rounded px-3.5 py-1.5 text-[12px] font-medium disabled:opacity-40"
        >
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
        <button
          onClick={runNow}
          disabled={running}
          className="bg-card border border-border rounded px-3.5 py-1.5 text-[12px] text-text-primary hover:border-accent-blue/40 disabled:opacity-50"
        >
          {running ? 'Backing up…' : 'Back up now'}
        </button>
        {dirty && <span className="text-[11px] text-accent-yellow">Unsaved changes</span>}
      </div>

      {state.snapshots.length > 0 && (
        <div className="mt-5 pt-4 border-t border-border">
          <div className="text-[11px] text-text-muted mb-2">
            Recent snapshots {state.total > state.snapshots.length && `(${state.snapshots.length} of ${state.total})`}
          </div>
          <div className="flex flex-col gap-1">
            {state.snapshots.map(s => (
              <div key={s.name} className="flex items-center gap-3 text-[11px]">
                <span className="font-mono text-text-secondary truncate flex-1">{s.name}</span>
                <span className="text-text-dim shrink-0">{(s.size / 1048576).toFixed(1)} MB</span>
                <span className="text-text-dim shrink-0 w-20 text-right">{timeAgo(s.modified)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function describe(f) {
  const at = `${String(f.hour).padStart(2, '0')}:${String(f.minute).padStart(2, '0')}`;
  if (f.frequency === 'hourly') return 'Backing up every hour';
  if (f.frequency === 'daily') return `Backing up daily at ${at}`;
  return `Backing up every ${WEEKDAYS[f.weekday]} at ${at}`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const then = new Date(ts);
  if (Number.isNaN(then.getTime())) return '';
  const mins = Math.floor((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}
