import type { ReactNode } from 'react';

// Segmented button group + labelled control wrapper — the dashboard's shared
// filter vocabulary. Extracted from Timeline so Facts, Audit, and the newer
// pages present identical controls.

export function ControlGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-3">
      <span className="label-meta">{label}</span>
      {children}
    </span>
  );
}

interface SegBtnGroupProps<T extends string | number> {
  value: T;
  options: ReadonlyArray<T>;
  onChange: (v: T) => void;
  render: (v: T) => string;
}

export function SegBtnGroup<T extends string | number>({
  value,
  options,
  onChange,
  render,
}: SegBtnGroupProps<T>) {
  return (
    <div className="flex flex-wrap items-center border border-hairline-strong">
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          onClick={() => onChange(o)}
          className={`px-3 py-1 font-mono text-2xs uppercase tracking-widest ${
            value === o ? 'bg-accent-500/10 text-accent-300' : 'text-ink-400 hover:text-ink-100'
          }`}
        >
          {render(o)}
        </button>
      ))}
    </div>
  );
}
