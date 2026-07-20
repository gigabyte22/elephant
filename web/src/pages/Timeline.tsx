import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MemoryKind, TimelineBucket } from '../api/types.ts';
import { PageHeading } from '../components/PageHeading.tsx';
import { ControlGroup, SegBtnGroup } from '../components/SegButtons.tsx';
import { ErrorBanner, LoadingBanner } from '../components/StateBanner.tsx';
import { useScope } from '../hooks/useScope.ts';
import { useTimeline } from '../hooks/useTimeline.ts';
import {
  chartColors,
  chartGridProps,
  chartTooltipProps,
  chartXAxisProps,
  chartYAxisProps,
} from '../lib/chartTheme.ts';
import { fmtKindLabel } from '../lib/format.ts';

// Timeline — recharts bar chart of ingestion per bucket. Kind + bucket + days
// are all selectable. Uses the dashboard's palette directly (no recharts
// defaults), 1px hairline axes, mono labels. Renders empty state inline.

const KIND_OPTIONS: MemoryKind[] = [
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

const BUCKETS: TimelineBucket[] = ['day', 'hour'];
const DAYS = [7, 30, 90, 365];

export function Timeline() {
  const scope = useScope();
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [bucket, setBucket] = useState<TimelineBucket>('day');
  const [days, setDays] = useState<number>(30);

  const timeline = useTimeline({ scope, kind, bucket, days });

  const points = timeline.data?.points ?? [];
  const total = points.reduce((a, b) => a + b.count, 0);

  return (
    <div className="mx-auto max-w-7xl pb-20">
      <PageHeading
        rank={6}
        title="timeline"
        right={
          <span className="label-key">
            {fmtKindLabel(kind)} · {bucket} · {days}d · total {total}
          </span>
        }
      />

      <div className="flex flex-wrap gap-x-6 gap-y-4 border-b border-hairline pb-6 mb-6">
        <ControlGroup label="kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as MemoryKind)}
            className="border border-hairline-strong bg-transparent px-3 py-1 font-mono text-2xs uppercase tracking-widest text-ink-100 focus:border-accent-500 focus:outline-none"
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k} className="bg-ink-900">
                {fmtKindLabel(k)}
              </option>
            ))}
          </select>
        </ControlGroup>
        <ControlGroup label="bucket">
          <SegBtnGroup
            value={bucket}
            options={BUCKETS}
            onChange={(v) => setBucket(v)}
            render={(v) => v.toUpperCase()}
          />
        </ControlGroup>
        <ControlGroup label="window">
          <SegBtnGroup
            value={days}
            options={DAYS}
            onChange={(v) => setDays(v)}
            render={(v) => `${v}d`}
          />
        </ControlGroup>
      </div>

      {timeline.isError && <ErrorBanner message={(timeline.error as Error).message} />}
      {timeline.isLoading && <LoadingBanner label="resolving time-series…" />}

      {timeline.data && (
        <section className="border-b border-hairline pb-10">
          {points.length === 0 ? (
            <div className="py-16 text-center font-mono text-2xs uppercase tracking-widest text-ink-500">
              no ingestion in this window
            </div>
          ) : (
            <div className="h-64 md:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={points.map((p) => ({ ...p, label: p.bucket.slice(0, 10) }))}
                  margin={{ top: 12, right: 0, left: -8, bottom: 0 }}
                >
                  <CartesianGrid {...chartGridProps} />
                  <XAxis dataKey="label" {...chartXAxisProps} minTickGap={24} />
                  <YAxis {...chartYAxisProps} />
                  <Tooltip {...chartTooltipProps} itemStyle={{ color: chartColors.accent }} />
                  <Bar dataKey="count" fill={chartColors.accent} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
