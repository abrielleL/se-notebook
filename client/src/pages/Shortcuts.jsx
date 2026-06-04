import Card from '../components/Card.jsx';

const shortcuts = [
  { key: '/', label: 'Focus global search' },
  { key: 'N', label: 'Open New Note form' },
  { key: 'S', label: 'Save current form' },
  { key: '?', label: 'Open this Shortcuts page' },
  { key: 'Esc', label: 'Blur input / close modal' }
];

export default function Shortcuts() {
  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="text-xl font-semibold text-text-primary mb-1">Keyboard shortcuts</h1>
      <div className="text-[12px] text-text-muted mb-6">
        Faster than the mouse. Most shortcuts work anywhere except inside a text field.
      </div>
      <Card className="p-2">
        <div className="grid grid-cols-2 gap-1">
          {shortcuts.map(s => (
            <div key={s.key} className="flex items-center gap-3 px-4 py-3 border border-border rounded">
              <span className="kbd font-mono">{s.key}</span>
              <span className="text-[12px] text-text-secondary">{s.label}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
