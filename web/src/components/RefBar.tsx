import { fmtCount } from '../lib/format.ts';

// Tiny strip-chart marker showing a fact's reference count as a horizontal
// fill against a hairline background, with the numeric count alongside.
// Shared between the Overview's top-facts preview and the Facts page so the
// visual vocabulary stays unified across the dashboard.

interface Props {
  pct: number;
  value: number;
}

export function RefBar({ pct, value }: Props) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="relative block h-2 w-16 bg-ink-700">
        <span className="absolute inset-y-0 left-0 bg-accent-500/85" style={{ width: `${pct}%` }} />
      </span>
      <span className="num text-xs text-ink-100">{fmtCount(value)}</span>
    </span>
  );
}
