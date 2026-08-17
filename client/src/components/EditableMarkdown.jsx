import { useState, useRef, useEffect } from 'react';
import Markdown from './Markdown.jsx';

// Shows rendered markdown by default with a small "Edit" affordance; clicking it
// (or double-clicking the text) swaps to a raw textarea. Changes propagate via
// onChange as the user types; leaving the field returns to the rendered view.
// Used where content is markdown but must stay editable (e.g. POV sections).
export default function EditableMarkdown({
  value,
  onChange,
  placeholder = 'Empty',
  className = '',
  textareaClassName = '',
  minHeight = 100
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      const len = ref.current.value.length;
      ref.current.setSelectionRange(len, len);
    }
  }, [editing]);

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        className={textareaClassName}
        style={{ minHeight }}
      />
    );
  }

  const hasText = value != null && String(value).trim() !== '';
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Edit"
        className="absolute top-1 right-1 z-10 opacity-0 group-hover:opacity-100 transition text-[10px] px-1.5 py-0.5 rounded bg-card border border-border text-text-muted hover:text-accent-blue hover:border-accent-blue/40"
      >
        Edit
      </button>
      <div onDoubleClick={() => setEditing(true)} className="cursor-text">
        {hasText
          ? <Markdown className={className}>{value}</Markdown>
          : <span className={`italic text-text-dim ${className}`}>{placeholder}</span>}
      </div>
    </div>
  );
}
