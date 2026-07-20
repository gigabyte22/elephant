import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { AtRiskFact, RetentionPayload } from '../api/types.ts';
import { LedgerScroll } from '../components/LedgerScroll.tsx';
import { PageHeading } from '../components/PageHeading.tsx';
import { ErrorBanner, LoadingBanner } from '../components/StateBanner.tsx';
import { useRetention } from '../hooks/useRetention.ts';
import { useScope } from '../hooks/useScope.ts';
import {
  chartColors,
  chartGridProps,
  chartTooltipProps,
  chartXAxisProps,
  chartYAxisProps,
} from '../lib/chartTheme.ts';
import { fmtCount, fmtRelativeTime } from '../lib/format.ts';

// Memory Health — the Ebbinghaus decay instrument. Every active fact holds a
// retention score e^(-days/strength) where strength grows with references
// and importance; this page shows the distribution (histogram), the decay
// field (scatter vs days-since-reference), and the facts closest to the
// prune floor.

export function MemoryHealth() {
  const scope = useScope();
  const retention = useRetention(scope);
  const data = retention.data;

  return (
    <div className="mx-auto max-w-7xl pb-20">
      <PageHeading
        rank={8}
        title="memory health"
        right={
          data ? (
            <span className="label-key">
              {fmtCount(data.totalActive)} active facts
              {data.truncated ? ' · sampled' : ''}
            </span>
          ) : undefined
        }
      />

      {retention.isError && <ErrorBanner message={(retention.error as Error).message} />}
      {retention.isLoading && <LoadingBanner label="computing retention curves…" />}

      {data && (
        <>
          <SummaryStrip data={data} />
          <div className="grid gap-10 border-b border-hairline py-8 lg:grid-cols-2">
            <Histogram data={data} />
            <DecayScatter data={data} />
          </div>
          <AtRiskLedger data={data} />
          <p className="pt-6 font-mono text-2xs leading-relaxed tracking-widest text-ink-500">
            RETENTION = e^(−DAYS/STRENGTH) · STRENGTH GROWS WITH REFERENCES AND IMPORTANCE · FACTS ≥{' '}
            {data.policy.importanceExempt.toFixed(2)} IMPORTANCE NEVER PRUNE · REFERENCED WITHIN{' '}
            {data.policy.minWindowDays}D NEVER PRUNE · PRUNE BELOW{' '}
            {data.policy.retentionFloor.toFixed(2)}
          </p>
        </>
      )}
    </div>
  );
}

// --- summary -------------------------------------------------------------------

function SummaryStrip({ data }: { data: RetentionPayload }) {
  const s = data.summary;
  return (
    <section className="grid grid-cols-2 border-b border-hairline sm:grid-cols-3 md:grid-cols-5">
      <Cell label="active facts" value={fmtCount(data.totalActive)} />
      <Cell label="exempt · durable" value={fmtCount(s.exempt)} tone="text-cyan-400" />
      <Cell label="within window" value={fmtCount(s.withinWindow)} />
      <Cell
        label="at risk"
        value={fmtCount(s.atRisk)}
        tone={s.atRisk > 0 ? 'text-rust' : undefined}
      />
      <Cell
        label="prunable now"
        value={fmtCount(s.prunable)}
        tone={s.prunable > 0 ? 'text-rust' : undefined}
      />
    </section>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 border-l border-hairline py-6 pl-6 pr-5 first:border-l-0 first:pl-0">
      <span className="label-meta">{label}</span>
      <span className={`num text-3xl font-light tracking-tight ${tone ?? 'text-ink-100'}`}>
        {value}
      </span>
    </div>
  );
}

// --- histogram -----------------------------------------------------------------

function Histogram({ data }: { data: RetentionPayload }) {
  const bins = data.histogram.map((b) => ({
    ...b,
    label: `${b.bin.toFixed(1)}–${(b.bin + 0.1).toFixed(1)}`,
  }));

  return (
    <section>
      <h2 className="label-meta pb-4">retention distribution</h2>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bins} margin={{ top: 8, right: 0, left: -8, bottom: 0 }}>
            <CartesianGrid {...chartGridProps} />
            <XAxis dataKey="label" {...chartXAxisProps} interval={1} />
            <YAxis {...chartYAxisProps} />
            <Tooltip
              {...chartTooltipProps}
              itemStyle={{ color: chartColors.accent }}
              labelFormatter={(label: string) => `retention ${label}`}
            />
            <ReferenceLine
              x={bins[0]?.label}
              stroke={chartColors.rust}
              strokeDasharray="4 4"
              label={{
                value: 'prune floor',
                fill: chartColors.rust,
                fontSize: 10,
                fontFamily: 'JetBrains Mono',
                position: 'insideTopLeft',
              }}
            />
            <Bar dataKey="count" name="facts" fill={chartColors.accent} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

// --- decay scatter ---------------------------------------------------------------

function DecayScatter({ data }: { data: RetentionPayload }) {
  const exempt = data.sample.filter((p) => p.exempt);
  const belowFloor = data.sample.filter(
    (p) => !p.exempt && p.retention < data.policy.retentionFloor,
  );
  const decaying = data.sample.filter(
    (p) => !p.exempt && p.retention >= data.policy.retentionFloor,
  );

  const series = [
    { name: 'decaying', points: decaying, color: chartColors.ink },
    { name: 'exempt', points: exempt, color: chartColors.cyan },
    { name: 'below floor', points: belowFloor, color: chartColors.rust },
  ];

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2 pb-4">
        <h2 className="label-meta">decay field · retention vs idle days</h2>
        <div className="flex flex-wrap items-baseline gap-4">
          {series.map((s) => (
            <span key={s.name} className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-2 w-2 self-center rounded-full"
                style={{ background: s.color }}
                aria-hidden
              />
              <span className="label-key">{s.name}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid {...chartGridProps} />
            <XAxis
              dataKey="daysSinceLastReference"
              type="number"
              name="idle days"
              {...chartXAxisProps}
              tickFormatter={(v: number) => `${Math.round(v)}d`}
            />
            <YAxis
              dataKey="retention"
              type="number"
              domain={[0, 1]}
              name="retention"
              {...chartYAxisProps}
              allowDecimals
            />
            <ZAxis range={[28, 28]} />
            <Tooltip
              {...chartTooltipProps}
              cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,196,225,0.2)' }}
              formatter={(value: number, name: string) =>
                name === 'idle days' ? Math.round(value) : Number(value).toFixed(3)
              }
            />
            <ReferenceLine
              y={data.policy.retentionFloor}
              stroke={chartColors.rust}
              strokeDasharray="4 4"
              label={{
                value: 'floor',
                fill: chartColors.rust,
                fontSize: 10,
                fontFamily: 'JetBrains Mono',
                position: 'insideTopRight',
              }}
            />
            <ReferenceLine
              x={data.policy.minWindowDays}
              stroke="rgba(255,196,225,0.25)"
              strokeDasharray="2 4"
              label={{
                value: `${data.policy.minWindowDays}d window`,
                fill: '#6A6580',
                fontSize: 10,
                fontFamily: 'JetBrains Mono',
                position: 'insideTopLeft',
              }}
            />
            {series.map((s) => (
              <Scatter
                key={s.name}
                name={s.name}
                data={s.points}
                fill={s.color}
                isAnimationActive={false}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

// --- at-risk ledger ---------------------------------------------------------------

const GRID = 'grid-cols-[2.5rem_1fr_4.5rem_4rem_4rem_6rem]';

function AtRiskLedger({ data }: { data: RetentionPayload }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section className="pt-8">
      <header className="flex items-baseline justify-between pb-5">
        <span className="label-meta">at risk of pruning</span>
        <span className="label-key text-ink-500">
          lowest retention first · {data.atRisk.length} shown
        </span>
      </header>
      {data.atRisk.length === 0 ? (
        <div className="border-y border-hairline py-12 text-center font-mono text-2xs uppercase tracking-widest text-ink-500">
          nothing at risk — every fact is exempt, fresh, or well-referenced
        </div>
      ) : (
        <LedgerScroll minWidth="42rem">
          <div className={`grid ${GRID} gap-5 border-y border-hairline py-2`}>
            <span className="label-key">#</span>
            <span className="label-key">content</span>
            <span className="label-key text-right">ret</span>
            <span className="label-key text-right">imp</span>
            <span className="label-key text-right">refs</span>
            <span className="label-key text-right">last hit</span>
          </div>
          <ol>
            {data.atRisk.map((f, i) => (
              <AtRiskRow
                key={f.id}
                fact={f}
                rank={i + 1}
                expanded={expanded === f.id}
                onToggle={() => setExpanded(expanded === f.id ? null : f.id)}
              />
            ))}
          </ol>
        </LedgerScroll>
      )}
    </section>
  );
}

function AtRiskRow({
  fact,
  rank,
  expanded,
  onToggle,
}: {
  fact: AtRiskFact;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={`border-b border-hairline ${fact.prunable ? 'relative' : ''}`}>
      {fact.prunable && (
        <span
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 bg-rust"
          style={{ boxShadow: '0 0 10px rgba(210,107,140,0.6)' }}
          aria-hidden
        />
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`grid w-full ${GRID} items-baseline gap-5 py-3 text-left hover:bg-white/[0.012]`}
      >
        <span className="font-mono text-2xs tabular-nums text-ink-500">
          {String(rank).padStart(2, '0')}
        </span>
        <span className="truncate text-sm text-ink-100">{fact.content}</span>
        <span className="num text-right text-xs text-rust">{fact.retention.toFixed(3)}</span>
        <span className="num text-right text-xs text-ink-300">{fact.importance.toFixed(2)}</span>
        <span className="num text-right text-xs text-ink-300">{fmtCount(fact.referenceCount)}</span>
        <span className="num text-right text-xs text-ink-400">
          {fmtRelativeTime(fact.lastReferencedAt)}
        </span>
      </button>
      {expanded && (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 border-l-2 border-rust/40 bg-white/[0.01] p-4 sm:grid-cols-4">
          <ExpandedItem label="idle" value={`${Math.round(fact.daysSinceLastReference)}d`} />
          <ExpandedItem
            label="prunable"
            value={fact.prunable ? 'yes' : 'not yet'}
            warn={fact.prunable}
          />
          <ExpandedItem label="retention" value={fact.retention.toFixed(4)} />
          <ExpandedItem label="id" value={fact.id} mono />
        </dl>
      )}
    </li>
  );
}

function ExpandedItem({
  label,
  value,
  warn,
  mono,
}: {
  label: string;
  value: string;
  warn?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="label-key">{label}</dt>
      <dd
        className={`truncate ${mono ? 'font-mono text-2xs text-ink-400' : `num text-sm ${warn ? 'text-rust' : 'text-ink-100'}`}`}
      >
        {value}
      </dd>
    </div>
  );
}
