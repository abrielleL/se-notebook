import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Card from '../components/Card.jsx';
import PovConfigSettings from './PovConfigSettings.jsx';
import TagSettings from './TagSettings.jsx';
import AeSettings from './AeSettings.jsx';
import CompanyProfileSettings from './CompanyProfileSettings.jsx';
import BackupSettings from './BackupSettings.jsx';
import DocsSyncSettings from './DocsSyncSettings.jsx';
import LocalModelSettings from './LocalModelSettings.jsx';

export default function Settings() {
  const [saved, setSaved] = useState(false);
  // Server-side, unlike the API key (which lives in the AI models section): the
  // POV docx is rendered on the server and needs this name for the Solutions
  // Engineer line on the cover.
  const [seName, setSeName] = useState('');

  useEffect(() => {
    api.getSeProfile().then(r => setSeName((r.config && r.config.name) || '')).catch(() => {});
  }, []);

  async function save() {
    try { await api.saveSeProfile({ name: seName.trim() }); } catch { return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  }

  return (
    <div className="max-w-[840px] mx-auto px-8 pt-8 pb-0">
      <h1 className="text-xl font-semibold text-text-primary mb-1">Settings</h1>
      <div className="text-[12px] text-text-muted mb-6">Local configuration. Nothing leaves this machine except the calls you make.</div>

      <LocalModelSettings />

      <Card className="p-6 mt-4">
        <div className="text-[13px] font-medium text-text-primary mb-1">Your name</div>
        <p className="text-[12px] text-text-muted mb-4 leading-relaxed">
          Used for the Solutions Engineer line on exported POV documents. The Account Executive on the
          same cover page comes from the AE recorded on each account.
        </p>
        <input
          value={seName}
          onChange={e => setSeName(e.target.value)}
          placeholder="e.g. Abrielle Land"
          className="w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue/50"
        />
      </Card>

      <DocsSyncSettings />

      <BackupSettings />

      <CompanyProfileSettings />

      <AeSettings />

      <TagSettings />

      <PovConfigSettings />

      {/* Sticky footer — Save is always reachable without scrolling */}
      <div className="sticky bottom-0 z-10 -mx-8 mt-6 px-4 py-2.5 bg-app border-t border-border flex items-center gap-3">
        <button
          onClick={save}
          className="bg-accent-blue/15 hover:bg-accent-blue/25 text-accent-blue border border-accent-blue/30 rounded px-4 py-1.5 text-[12px] font-medium"
        >
          Save
        </button>
        {saved && (
          <span className="text-[12px] text-accent-green flex items-center gap-1">
            ✓ Changes saved
          </span>
        )}
        <span className="ml-auto text-[10px] text-text-dim">POV generator options below save instantly as you edit them.</span>
      </div>
    </div>
  );
}
