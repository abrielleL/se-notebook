// Single source of truth for OPSWAT presales stages. Import from here (or via
// re-exports in constants.js) — never hardcode stage strings in components.
export const PRESALES_STAGES = [
  '1-Discovery',
  '2-Demo',
  '3-Workshop',
  '4-Planning',
  '5-Deployment',
  '6-In Progress',
  '7-Technical Win',
  '8-Technical Loss',
  'Not Required',
  'Stalled',
  'Canceled',
];

export const STAGE_COLORS = {
  '1-Discovery':      { bg: 'bg-blue-50',   text: 'text-blue-700',  dot: '#378ADD' },
  '2-Demo':           { bg: 'bg-blue-50',   text: 'text-blue-700',  dot: '#378ADD' },
  '3-Workshop':       { bg: 'bg-blue-50',   text: 'text-blue-700',  dot: '#378ADD' },
  '4-Planning':       { bg: 'bg-blue-50',   text: 'text-blue-700',  dot: '#378ADD' },
  '5-Deployment':     { bg: 'bg-amber-50',  text: 'text-amber-700', dot: '#BA7517' },
  '6-In Progress':    { bg: 'bg-amber-50',  text: 'text-amber-700', dot: '#BA7517' },
  '7-Technical Win':  { bg: 'bg-green-50',  text: 'text-green-700', dot: '#639922' },
  '8-Technical Loss': { bg: 'bg-red-50',    text: 'text-red-700',   dot: '#E24B4A' },
  'Not Required':     { bg: 'bg-gray-50',   text: 'text-gray-500',  dot: '#888780' },
  'Stalled':          { bg: 'bg-gray-50',   text: 'text-gray-500',  dot: '#888780' },
  'Canceled':         { bg: 'bg-gray-50',   text: 'text-gray-500',  dot: '#888780' },
};

const FALLBACK = { bg: 'bg-gray-50', text: 'text-gray-500', dot: '#888780' };

export function stageColor(stage) {
  return STAGE_COLORS[stage] || FALLBACK;
}

// Tailwind classes for a stage badge pill.
export function stageBadgeClass(stage) {
  const c = stageColor(stage);
  return `${c.bg} ${c.text}`;
}
