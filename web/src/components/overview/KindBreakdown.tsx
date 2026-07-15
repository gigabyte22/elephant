import { useMemo } from 'react';
import type { MemoryKind, StatsPayload } from '../../api/types.ts';
import { fmtCount, fmtKindLabel } from '../../lib/format.ts';
import { CompositionBar } from '../CompositionBar.tsx';

// Memory composition by kind — delegates the tonal bar + legend rendering to
// the shared CompositionBar; this component owns the kind ordering and the
// section chrome.

const KIND_ORDER: MemoryKind[] = [
  'fact',
  'episode',
  'chunk',
  'observation',
  'preference',
  'insight',
  'intention',
  'knowledge_document',
  'knowledge_chunk',
  'procedure',
  'research',
];

interface Props {
  stats: StatsPayload;
}

export function KindBreakdown({ stats }: Props) {
  const ordered = useMemo(() => {
    const map = new Map(stats.kindCounts.map((k) => [k.kind, k.count]));
    return KIND_ORDER.map((kind) => ({
      key: kind,
      label: fmtKindLabel(kind),
      count: map.get(kind) ?? 0,
    })).filter((r) => r.count > 0);
  }, [stats.kindCounts]);

  const total = ordered.reduce((a, b) => a + b.count, 0);
  if (total === 0) return null;

  return (
    <section
      className="border-b border-hairline py-8 animate-fade-up"
      style={{ animationDelay: '80ms' }}
    >
      <header className="flex items-center justify-between pb-5">
        <span className="label-meta">memory · by kind</span>
        <span className="label-key text-ink-500">
          {fmtCount(total)} items · {ordered.length} kinds
        </span>
      </header>
      <CompositionBar items={ordered} />
    </section>
  );
}
