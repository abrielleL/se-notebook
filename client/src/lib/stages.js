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

// Stage badge colors.
//
// These were Tailwind's default light scales (bg-blue-50 / text-blue-700),
// which rendered as pale pills on a dark app and are a library default rather
// than a brand value. They now use the same tint/ink pairs as the stage bar in
// constants.js: a flattened brand status tint behind the matching dark-mode
// status ink.
export const STAGE_COLORS = {
  '1-Discovery':      { bg: 'bg-[#0c295f]', text: 'text-[#5c9bff]', dot: '#1d6bfc' },
  '2-Demo':           { bg: 'bg-[#0c295f]', text: 'text-[#5c9bff]', dot: '#1d6bfc' },
  '3-Workshop':       { bg: 'bg-[#0c295f]', text: 'text-[#5c9bff]', dot: '#1d6bfc' },
  '4-Planning':       { bg: 'bg-[#0c295f]', text: 'text-[#5c9bff]', dot: '#1d6bfc' },
  '5-Deployment':     { bg: 'bg-[#2e1d18]', text: 'text-[#ff9a4d]', dot: '#ff9a4d' },
  '6-In Progress':    { bg: 'bg-[#2e1d18]', text: 'text-[#ff9a4d]', dot: '#ff9a4d' },
  '7-Technical Win':  { bg: 'bg-[#032417]', text: 'text-[#4fd15c]', dot: '#4fd15c' },
  '8-Technical Loss': { bg: 'bg-[#290b17]', text: 'text-[#ff6b66]', dot: '#ff6b66' },
  'Not Required':     { bg: 'bg-[#111f42]', text: 'text-[#838892]', dot: '#838892' },
  'Stalled':          { bg: 'bg-[#111f42]', text: 'text-[#838892]', dot: '#838892' },
  'Canceled':         { bg: 'bg-[#111f42]', text: 'text-[#838892]', dot: '#838892' },
};

const FALLBACK = { bg: 'bg-[#111f42]', text: 'text-[#838892]', dot: '#838892' };

export function stageColor(stage) {
  return STAGE_COLORS[stage] || FALLBACK;
}

// Tailwind classes for a stage badge pill.
export function stageBadgeClass(stage) {
  const c = stageColor(stage);
  return `${c.bg} ${c.text}`;
}
