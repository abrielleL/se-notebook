import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../lib/api.js';
import { STAGE_GATES } from '../lib/constants.js';

// Opens when advancing a stage. Lists gate items for the TARGET stage; each
// checkable. "Advance anyway" overrides incomplete gates.
export default function StageGateModal({ accountId, targetStage, onAdvance, onClose }) {
  const gates = STAGE_GATES[targetStage] || [];
  const [state, setState] = useState({});

  useEffect(() => {
    if (!gates.length) return;
    api.getStageGates(accountId, targetStage).then(res => setState(res.gates || {})).catch(() => {});
  }, [accountId, targetStage]);

  async function toggle(key) {
    const next = !(state[key] && state[key].completed);
    setState(s => ({ ...s, [key]: { ...(s[key] || {}), completed: next } }));
    await api.updateStageGate(accountId, targetStage, key, next).catch(() => {});
  }

  const allDone = gates.length > 0 && gates.every(g => state[g.key] && state[g.key].completed);

  return (
    <Modal title={`Advance to ${targetStage}`} onClose={onClose} width="max-w-md"
      footer={
        <>
          <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-primary">Complete items first</button>
          <button onClick={() => onAdvance(targetStage)}
            className={`rounded px-3 py-1.5 text-[12px] font-medium border ${allDone ? 'bg-accent-green/15 text-accent-green border-accent-green/30' : 'bg-accent-blue/15 text-accent-blue border-accent-blue/30'}`}>
            {allDone ? 'Advance' : 'Advance anyway'}
          </button>
        </>
      }>
      {gates.length === 0 ? (
        <div className="text-[12px] text-text-muted">No gate checklist defined for this stage. Advance when ready.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {gates.map(g => {
            const done = state[g.key] && state[g.key].completed;
            return (
              <button key={g.key} onClick={() => toggle(g.key)}
                className="flex items-center gap-2.5 px-3 py-2 border border-border rounded text-left hover:border-accent-blue/40">
                <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 ${done ? 'bg-accent-green border-accent-green text-black' : 'border-text-dim'}`}>{done ? '✓' : ''}</span>
                <span className={`text-[12px] ${done ? 'text-text-primary' : 'text-text-secondary'}`}>{g.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
