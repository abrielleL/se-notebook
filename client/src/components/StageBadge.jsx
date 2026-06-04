import { stageBadgeClass } from '../lib/stages.js';

// Presales stage badge, colored per STAGE_COLORS.
export default function StageBadge({ stage }) {
  if (!stage) return null;
  return (
    <span className={`inline-block px-2 py-[3px] text-[11px] font-medium rounded ${stageBadgeClass(stage)}`}>
      {stage}
    </span>
  );
}
