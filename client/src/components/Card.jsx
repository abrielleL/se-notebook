export default function Card({ children, className = '', style }) {
  return (
    <div
      className={`bg-card border border-border rounded-lg ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, right, icon: IconCmp }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border">
      <div className="flex items-center gap-2 min-w-0">
        {IconCmp && <IconCmp width={14} height={14} className="text-text-muted shrink-0" />}
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-text-primary truncate">{title}</div>
          {subtitle && <div className="text-[10px] text-text-dim truncate mt-0.5">{subtitle}</div>}
        </div>
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  );
}
