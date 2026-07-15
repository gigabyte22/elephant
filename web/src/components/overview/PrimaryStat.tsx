import { useMemo } from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import type { StatsPayload, TimelinePayload } from '../../api/types.ts';
import { fmtCount } from '../../lib/format.ts';

// The headline figure on the Overview — "active facts" rendered as the
// dashboard's loudest single number. A 30-day ingestion sparkline drifts
// underneath at 30% opacity so the number reads first and the trend reads
// second. No axis, no tooltip — just the silhouette.

interface Props {
  stats: StatsPayload;
  timeline: TimelinePayload | undefined;
  timelineError?: boolean;
}

export function PrimaryStat({ stats, timeline, timelineError }: Props) {
  const sparklineData = useMemo(
    () =>
      (timeline?.points ?? []).map((p) => ({
        x: p.bucket,
        y: p.count,
      })),
    [timeline?.points],
  );

  const totalIngested = sparklineData.reduce((a, b) => a + b.y, 0);

  return (
    <section className="projected relative border-b border-hairline pb-10 animate-fade-up">
      <header className="flex items-center justify-between">
        <span className="label-meta">active facts</span>
        {timelineError ? (
          <span className="label-key text-rust">sparkline unavailable</span>
        ) : (
          <span className="label-key text-ink-500">
            last 30d ingested · {fmtCount(totalIngested)}
          </span>
        )}
      </header>
      <div className="relative mt-6 h-32">
        {/* Sparkline (background layer) */}
        <div className="pointer-events-none absolute inset-0 opacity-70">
          {sparklineData.length > 1 && (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={sparklineData} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="ingest-spark" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#FF5C8A" stopOpacity={0.38} />
                    <stop offset="100%" stopColor="#FF5C8A" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="y"
                  stroke="#FF5C8A"
                  strokeOpacity={0.7}
                  strokeWidth={1.2}
                  fill="url(#ingest-spark)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        {/* Number (foreground) — display font with chromatic-aberration shimmer */}
        <div className="relative z-10 flex h-full items-end">
          <span className="font-cinema text-[5.5rem] font-light leading-none tracking-tight text-ink-100 chroma tabular-nums md:text-[8.5rem]">
            {fmtCount(stats.facts.active)}
          </span>
        </div>
      </div>
      <footer className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-2 text-ink-300">
        <MetaItem label="superseded" value={stats.facts.superseded} />
        <Sep />
        <MetaItem label="soft-deleted" value={stats.facts.softDeleted} />
        <Sep />
        <MetaItem label="supersede edges" value={stats.supersedeEdges} />
      </footer>
    </section>
  );
}

function MetaItem({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="label-key">{label}</span>
      <span className="num text-sm text-ink-100">{fmtCount(value)}</span>
    </span>
  );
}

function Sep() {
  return <span className="h-3 w-px bg-hairline" aria-hidden />;
}
