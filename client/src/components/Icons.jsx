const baseProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
};

export const Icon = {
  Home: (p) => <svg {...baseProps} {...p}><path d="M3 12 12 3l9 9"/><path d="M5 10v10h14V10"/></svg>,
  Folder: (p) => <svg {...baseProps} {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>,
  Plus: (p) => <svg {...baseProps} {...p}><path d="M12 5v14M5 12h14"/></svg>,
  Search: (p) => <svg {...baseProps} {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  Gear: (p) => <svg {...baseProps} {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9A1.7 1.7 0 0 0 10 4.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V10c.4.2.7.5 1 .9.2.3.3.7.3 1.1z"/></svg>,
  Sparkles: (p) => <svg {...baseProps} {...p}><path d="M12 3 14 9l6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>,
  Check: (p) => <svg {...baseProps} {...p}><path d="m5 12 5 5 9-11"/></svg>,
  Trash: (p) => <svg {...baseProps} {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>,
  Edit: (p) => <svg {...baseProps} {...p}><path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>,
  Eye: (p) => <svg {...baseProps} {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>,
  Download: (p) => <svg {...baseProps} {...p}><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>,
  Upload: (p) => <svg {...baseProps} {...p}><path d="M12 21V9M7 14l5-5 5 5M5 3h14"/></svg>,
  Back: (p) => <svg {...baseProps} {...p}><path d="m15 6-6 6 6 6"/></svg>,
  Refresh: (p) => <svg {...baseProps} {...p}><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>,
  Sync: (p) => <svg {...baseProps} {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>,
  Note: (p) => <svg {...baseProps} {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>,
  Calendar: (p) => <svg {...baseProps} {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
  File: (p) => <svg {...baseProps} {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>,
  Export: (p) => <svg {...baseProps} {...p}><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 21h14"/></svg>,
  Mic: (p) => <svg {...baseProps} {...p}><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>,
  Link: (p) => <svg {...baseProps} {...p}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>,
  Keyboard: (p) => <svg {...baseProps} {...p}><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>,
  X: (p) => <svg {...baseProps} {...p}><path d="M18 6 6 18M6 6l12 12"/></svg>
};

export default Icon;
