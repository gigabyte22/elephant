import { fmtCount } from '../lib/format.ts';

// Single-row tonal composition bar + legend grid — each item's share of a
// whole as a horizontal segment. Accent for the lead segment, descending ink
// tones for the rest; the legend carries the counts so identity never rides
// on color alone. Shared by the Overview kind breakdown and the Entities
// type breakdown. No pies — the aesthetic has none.

const TONES = [
  'bg-accent-500',
  'bg-ink-200/85',
  'bg-ink-300/75',
  'bg-ink-300/55',
  'bg-ink-400/70',
  'bg-ink-400/55',
  'bg-ink-500/85',
  'bg-ink-500/65',
  'bg-ink-500/45',
  'bg-ink-600',
];

export interface CompositionItem {
  key: string;
  label: string;
  count: number;
}

interface Props {
  items: CompositionItem[];
}

export function CompositionBar({ items }: Props) {
  const total = items.reduce((a, b) => a + b.count, 0);
  if (total === 0) return null;

  return (
    <>
      <div className="flex h-2 w-full overflow-hidden">
        {items.map((row, i) => {
          const pct = (row.count / total) * 100;
          return (
            <div
              key={row.key}
              className={`${TONES[i] ?? 'bg-ink-500/30'} group relative`}
              style={{ width: `${pct}%` }}
              title={`${row.label} — ${fmtCount(row.count)}`}
            />
          );
        })}
      </div>
      <ol className="mt-6 grid grid-cols-2 gap-x-8 gap-y-2 md:grid-cols-3 lg:grid-cols-5">
        {items.map((row, i) => (
          <li
            key={row.key}
            className="flex items-baseline justify-between gap-3 border-b border-hairline py-2"
          >
            <span className="flex items-center gap-2">
              <span className={`h-2 w-2 ${TONES[i] ?? 'bg-ink-500/30'}`} aria-hidden />
              <span className="font-mono text-2xs uppercase tracking-widest text-ink-300">
                {row.label}
              </span>
            </span>
            <span className="num text-sm text-ink-100">{fmtCount(row.count)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}
