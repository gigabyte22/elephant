import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DreamRunSummary } from '../api/types.ts';
import { DetailPanel } from '../components/DetailPanel.tsx';
import { LedgerScroll } from '../components/LedgerScroll.tsx';
import { PageHeading } from '../components/PageHeading.tsx';
import { ErrorBanner, LoadingBanner } from '../components/StateBanner.tsx';
import { useDreams } from '../hooks/useDreams.ts';
import {
  chartColors,
  chartGridProps,
  chartTooltipProps,
  chartXAxisProps,
  chartYAxisProps,
} from '../lib/chartTheme.ts';
import { fmtCount, fmtMs, fmtRelativeTime } from '../lib/format.ts';

// Dream Runs — the audit ledger for background consolidation cycles, topped
// by a stacked activity chart (created / superseded / merged / pruned per
// cycle). Each row is one cycle, newest first; failures surface their error
// inline and clicking a row opens the full counter breakdown.

const GRID =
  'grid-cols-[1.5rem_7rem_4rem_3.5rem_4.5rem_4.5rem_4.5rem_4.5rem_4.5rem_4rem_minmax(6rem,1fr)]';

// Stack order + palette validated for CVD separation (worst adjacent pair
// ΔE 13.7): accent / cyan / neutral ink / rust, with a 2px void gap between
// segments and a labeled legend so identity never rides on color alone.
const SERIES = [
  { key: 'factsCreated', label: 'created', color: chartColors.accent },
  { key: 'factsSuperseded', label: 'superseded', color: chartColors.cyan },
  { key: 'factsMerged', label: 'merged', color: chartColors.ink },
  { key: 'factsPruned', label: 'pruned', color: chartColors.rust },
] as const;

export function Dreams() {
  const dreams = useDreams(50);
  const [selected, setSelected] = useState<DreamRunSummary | null>(null);
  const items = dreams.data?.items ?? [];

  const aggregate = items.reduce(
    (acc, d) => {
      acc.factsCreated += d.factsCreated;
      acc.factsSuperseded += d.factsSuperseded;
      acc.factsPruned += d.factsPruned;
      acc.factsMerged += d.factsMerged;
      acc.insightsPromoted += d.insightsPromoted;
      return acc;
    },
    { factsCreated: 0, factsSuperseded: 0, factsPruned: 0, factsMerged: 0, insightsPromoted: 0 },
  );

  return (
    <div className="mx-auto max-w-7xl pb-20">
      <PageHeading
        rank={7}
        title="dream runs"
        right={
          <div className="flex flex-wrap items-baseline gap-x-7 gap-y-2">
            <Agg label="cycles" value={items.length} />
            <Agg label="created" value={aggregate.factsCreated} />
            <Agg label="superseded" value={aggregate.factsSuperseded} />
            <Agg label="merged" value={aggregate.factsMerged} />
            <Agg label="pruned" value={aggregate.factsPruned} />
            <Agg label="insights" value={aggregate.insightsPromoted} />
          </div>
        }
      />

      {dreams.isError && <ErrorBanner message={(dreams.error as Error).message} />}
      {dreams.isLoading && <LoadingBanner label="reading dream ledger…" />}

      {dreams.data && (
        <>
          {items.length > 1 && <ActivityChart items={items} />}

          <LedgerScroll minWidth="56rem">
            <RowHeader />
            {items.length === 0 ? (
              <div className="border-b border-hairline py-12 text-center font-mono text-2xs uppercase tracking-widest text-ink-500">
                no dream cycles recorded yet
              </div>
            ) : (
              <ol>
                {items.map((d) => (
                  <Row key={d.id} run={d} onOpen={() => setSelected(d)} />
                ))}
              </ol>
            )}
          </LedgerScroll>
        </>
      )}

      <DreamRunPanel run={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// --- activity chart -----------------------------------------------------------

function ActivityChart({ items }: { items: DreamRunSummary[] }) {
  // API returns newest first; the chart reads left → right in time.
  const data = [...items].reverse().map((d) => ({
    ...d,
    label: d.startedAt.slice(5, 10),
  }));

  return (
    <section className="mb-8 border-b border-hairline pb-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="label-meta">activity per cycle</h2>
        <div className="flex flex-wrap items-baseline gap-4">
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-2 w-2 self-center"
                style={{ background: s.color }}
                aria-hidden
              />
              <span className="label-key">{s.label}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="h-48 md:h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 0, left: -8, bottom: 0 }}>
            <CartesianGrid {...chartGridProps} />
            <XAxis dataKey="label" {...chartXAxisProps} minTickGap={24} />
            <YAxis {...chartYAxisProps} />
            <Tooltip
              {...chartTooltipProps}
              itemStyle={{ color: '#E6E1ED' }}
              labelFormatter={(label: string) => `cycle · ${label}`}
            />
            {SERIES.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="cycle"
                fill={s.color}
                stroke="#06050C"
                strokeWidth={2}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

// --- ledger --------------------------------------------------------------------

function Agg({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="label-key">{label}</span>
      <span className="num text-sm text-ink-100">{fmtCount(value)}</span>
    </span>
  );
}

function RowHeader() {
  return (
    <div className={`grid ${GRID} items-baseline gap-4 border-y border-hairline py-2`}>
      <span className="label-key">·</span>
      <span className="label-key">started</span>
      <span className="label-key text-right">dur</span>
      <span className="label-key text-right">eps</span>
      <span className="label-key text-right">+facts</span>
      <span className="label-key text-right">supersd</span>
      <span className="label-key text-right">merged</span>
      <span className="label-key text-right">pruned</span>
      <span className="label-key text-right">+insight</span>
      <span className="label-key text-right">fails</span>
      <span className="label-key">id</span>
    </div>
  );
}

function failureCount(run: DreamRunSummary): number {
  return run.episodesFailed + run.extractionFailures + run.supersedeFailures;
}

function Row({ run, onOpen }: { run: DreamRunSummary; onOpen: () => void }) {
  const statusColor =
    run.status === 'completed'
      ? 'bg-sage'
      : run.status === 'running'
        ? 'bg-accent-500 animate-scan'
        : 'bg-rust';
  const fails = failureCount(run);

  return (
    <li className="border-b border-hairline">
      <button
        type="button"
        onClick={onOpen}
        className={`grid w-full ${GRID} items-baseline gap-4 py-3 text-left hover:bg-white/[0.012]`}
      >
        <span className="flex h-full items-center">
          <span className={`h-2 w-2 rounded-full ${statusColor}`} aria-hidden />
        </span>
        <span className="num text-xs text-ink-100">{fmtRelativeTime(run.startedAt)}</span>
        <span className="num text-right text-xs text-ink-300">{fmtMs(run.durationMs)}</span>
        <span className="num text-right text-xs text-ink-300">
          {fmtCount(run.episodesProcessed)}
        </span>
        <span className="num text-right text-xs text-accent-300">
          +{fmtCount(run.factsCreated)}
        </span>
        <span className="num text-right text-xs text-ink-300">{fmtCount(run.factsSuperseded)}</span>
        <span className="num text-right text-xs text-ink-300">{fmtCount(run.factsMerged)}</span>
        <span className="num text-right text-xs text-ink-300">{fmtCount(run.factsPruned)}</span>
        <span className="num text-right text-xs text-ink-300">
          +{fmtCount(run.insightsPromoted)}
        </span>
        <span className={`num text-right text-xs ${fails > 0 ? 'text-rust' : 'text-ink-500'}`}>
          {fmtCount(fails)}
        </span>
        <span className="truncate font-mono text-2xs text-ink-500">{run.id}</span>
      </button>
      {run.status === 'failed' && run.error && (
        <p className="break-words border-l-2 border-rust/60 py-2 pl-4 pr-2 font-mono text-2xs text-rust">
          {run.error}
        </p>
      )}
    </li>
  );
}

// --- drill-down ------------------------------------------------------------------

function DreamRunPanel({ run, onClose }: { run: DreamRunSummary | null; onClose: () => void }) {
  return (
    <DetailPanel
      open={run !== null}
      onClose={onClose}
      title={
        <div className="flex items-baseline gap-3">
          <span className="label-meta">dream cycle</span>
          <span className="truncate font-mono text-2xs text-ink-500">{run?.id}</span>
        </div>
      }
    >
      {run && <DreamRunBody run={run} />}
    </DetailPanel>
  );
}

function DreamRunBody({ run }: { run: DreamRunSummary }) {
  const statusTone =
    run.status === 'completed'
      ? 'text-cyan-400'
      : run.status === 'running'
        ? 'text-accent-300'
        : 'text-rust';

  return (
    <div className="flex flex-col gap-7">
      <div className="grid grid-cols-3 gap-4 border-y border-hairline py-4">
        <PanelStat label="status" value={run.status} tone={statusTone} />
        <PanelStat label="started" value={fmtRelativeTime(run.startedAt)} />
        <PanelStat label="duration" value={fmtMs(run.durationMs)} />
      </div>

      <CounterSection
        label="episodes"
        rows={[
          ['processed', run.episodesProcessed],
          ['failed', run.episodesFailed, run.episodesFailed > 0],
        ]}
      />
      <CounterSection
        label="facts"
        rows={[
          ['created', run.factsCreated],
          ['superseded', run.factsSuperseded],
          ['merged', run.factsMerged],
          ['pruned', run.factsPruned],
          ['insights promoted', run.insightsPromoted],
        ]}
      />
      <CounterSection
        label="knowledge graph"
        rows={[
          ['relations created', run.relationsCreated],
          ['synonyms created', run.synonymsCreated],
          ['entities re-embedded', run.entitiesReembedded],
        ]}
      />
      <CounterSection
        label="failures"
        rows={[
          ['extraction', run.extractionFailures, run.extractionFailures > 0],
          ['supersede', run.supersedeFailures, run.supersedeFailures > 0],
        ]}
      />

      {run.error && (
        <section>
          <h3 className="label-key border-b border-hairline pb-2">error</h3>
          <p className="break-words pt-3 font-mono text-2xs leading-relaxed text-rust">
            {run.error}
          </p>
        </section>
      )}

      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(run.id)}
        className="self-start border border-hairline-strong px-3 py-1 font-mono text-2xs uppercase tracking-widest text-ink-400 transition-colors hover:border-accent-500 hover:text-accent-300"
      >
        copy run id
      </button>
    </div>
  );
}

function PanelStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label-key">{label}</span>
      <span className={`num text-sm uppercase ${tone ?? 'text-ink-100'}`}>{value}</span>
    </div>
  );
}

function CounterSection({
  label,
  rows,
}: {
  label: string;
  rows: Array<[string, number, boolean?]>;
}) {
  return (
    <section>
      <h3 className="label-key border-b border-hairline pb-2">{label}</h3>
      <dl className="flex flex-col gap-2 pt-3">
        {rows.map(([name, value, warn]) => (
          <div key={name} className="flex items-baseline justify-between gap-4">
            <dt className="font-mono text-2xs uppercase tracking-widest text-ink-400">{name}</dt>
            <dd className={`num text-sm ${warn ? 'text-rust' : 'text-ink-100'}`}>
              {fmtCount(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
