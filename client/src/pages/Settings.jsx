import { useState } from 'react';
import { ANTHROPIC_KEY_STORAGE } from '../lib/ai.js';
import Card from '../components/Card.jsx';
import PovConfigSettings from './PovConfigSettings.jsx';
import TagSettings from './TagSettings.jsx';

export default function Settings() {
  const [value, setValue] = useState(localStorage.getItem(ANTHROPIC_KEY_STORAGE) || '');
  const [saved, setSaved] = useState(false);

  function save() {
    localStorage.setItem(ANTHROPIC_KEY_STORAGE, value.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  }

  function clear() {
    localStorage.removeItem(ANTHROPIC_KEY_STORAGE);
    setValue('');
  }

  return (
    <div className="max-w-[840px] mx-auto px-8 pt-8 pb-0">
      <h1 className="text-xl font-semibold text-text-primary mb-1">Settings</h1>
      <div className="text-[12px] text-text-muted mb-6">Local configuration. Nothing leaves this machine except the calls you make.</div>

      <Card className="p-6">
        <div className="text-[13px] font-medium text-text-primary mb-1">Anthropic API Key</div>
        <p className="text-[12px] text-text-muted mb-4 leading-relaxed">
          Your key is stored only in your browser and sent directly to Anthropic. It never touches this server.
          Create one at <span className="text-accent-blue">console.anthropic.com</span>.
        </p>
        <input
          type="password"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="sk-ant-..."
          className="w-full bg-[#040d1c] border border-border rounded px-3 py-2 text-[12px] text-text-primary placeholder-text-dim font-mono focus:outline-none focus:border-accent-blue/50"
        />
        {value && (
          <button onClick={clear} className="text-[12px] text-text-muted hover:text-accent-red mt-3">
            Clear key
          </button>
        )}
      </Card>

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
