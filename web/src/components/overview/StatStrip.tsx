import type { StatsPayload } from '../../api/types.ts';
import { fmtCount, fmtMs, fmtRelativeTime } from '../../lib/format.ts';

// A horizontal strip of secondary instrument readings beneath the primary
// stat. Hairlines between cells, mono numbers, small-caps labels. No boxes.

interface Props {
  stats: StatsPayload;
}

export function StatStrip({ stats }: Props) {
  const dream = stats.lastDream;
  return (
    <section
      className="grid grid-cols-2 md:grid-cols-4 border-b border-hairline animate-fade-up"
      style={{ animationDelay: '40ms' }}
    >
      <Cell label="entities" value={fmtCount(stats.entities)} />
      <Cell
        label="observations · active"
        value={fmtCount(stats.observations.active)}
        sub={`${fmtCount(stats.observations.expired)} expired`}
      />
      <Cell label="supersede edges" value={fmtCount(stats.supersedeEdges)} sub="lineage links" />
      <Cell
        label="last dream"
        value={dream ? fmtRelativeTime(dream.completedAt) : '—'}
        sub={
          dream ? `+${fmtCount(dream.factsCreated)} · ~${fmtMs(dream.durationMs)}` : 'no cycles yet'
        }
      />
    </section>
  );
}

function Cell({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="relative flex flex-col gap-1 py-6 pl-6 pr-5 first:pl-0 border-l border-hairline first:border-l-0 last:pr-0">
      <span className="label-meta">{label}</span>
      <span className="num text-3xl font-light tracking-tight text-ink-100">{value}</span>
      {sub && <span className="font-mono text-2xs text-ink-400">{sub}</span>}
    </div>
  );
}
