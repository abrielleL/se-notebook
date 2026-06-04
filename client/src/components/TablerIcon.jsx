// Renders a Tabler icon by its webfont class name (e.g. "ti-shield").
// Falls back to ti-circle when no name is given. The webfont CSS is imported
// once in main.jsx.
export default function TablerIcon({ name, className = '', style }) {
  const icon = name && name.startsWith('ti-') ? name : (name ? `ti-${name}` : 'ti-circle');
  return <i className={`ti ${icon} ${className}`} style={style} aria-hidden="true" />;
}
