import { PageHeading } from '../components/PageHeading.tsx';
import { ErrorBanner, LoadingBanner } from '../components/StateBanner.tsx';
import { EpisodeOriginStrip } from '../components/overview/EpisodeOriginStrip.tsx';
import { KindBreakdown } from '../components/overview/KindBreakdown.tsx';
import { PrimaryStat } from '../components/overview/PrimaryStat.tsx';
import { StatStrip } from '../components/overview/StatStrip.tsx';
import { TopFactsPreview } from '../components/overview/TopFactsPreview.tsx';
import { useEpisodeOrigins } from '../hooks/useEpisodeOrigins.ts';
import { useScope } from '../hooks/useScope.ts';
import { useStats } from '../hooks/useStats.ts';
import { useTimeline } from '../hooks/useTimeline.ts';
import { useTopFacts } from '../hooks/useTopFacts.ts';
import { activeScopeAxes } from '../lib/scope.ts';

// Overview — the dashboard's first impression. Composes five read panels:
//  1. PrimaryStat   — headline number + 30-day ingestion sparkline
//  2. StatStrip     — secondary instrument readings
//  3. KindBreakdown — memory composition bar + legend
//  4. EpisodeOriginStrip — episode provenance counts
//  5. TopFactsPreview — five most-referenced facts (link to /facts)
// Every panel has an explicit loading/error surface — a failed fetch shows a
// banner, never a silent blank.

export function Overview() {
  const scope = useScope();
  const stats = useStats(scope);
  const timeline = useTimeline({ scope, kind: 'fact', bucket: 'day', days: 30 });
  const topFacts = useTopFacts({ scope, sort: 'refs', limit: 5 });
  const origins = useEpisodeOrigins(scope);

  const axes = activeScopeAxes(scope);

  return (
    <div className="mx-auto max-w-7xl pb-20">
      <PageHeading
        rank={1}
        title="overview"
        bottomGap="md"
        right={<LiveReadout axesCount={axes.length} />}
      />
      {stats.isError && (
        <ErrorBanner message={(stats.error as Error).message ?? 'failed to load stats'} />
      )}
      {stats.isLoading && <LoadingBanner label="reading memory state…" />}
      {stats.data && (
        <>
          <PrimaryStat
            stats={stats.data}
            timeline={timeline.data}
            timelineError={timeline.isError}
          />
          <StatStrip stats={stats.data} />
          <KindBreakdown stats={stats.data} />
        </>
      )}
      {origins.data && <EpisodeOriginStrip payload={origins.data} />}
      {topFacts.isError && (
        <ErrorBanner message={(topFacts.error as Error).message ?? 'failed to load top facts'} />
      )}
      {topFacts.isLoading && <LoadingBanner label="reading top facts…" />}
      {topFacts.data && <TopFactsPreview items={topFacts.data.items} />}
    </div>
  );
}

function LiveReadout({ axesCount }: { axesCount: number }) {
  return (
    <div className="text-right">
      <div className="flex items-center justify-end gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-accent-500 animate-pulse" aria-hidden />
        <span className="label-meta">live readout</span>
      </div>
      <div className="font-mono text-2xs text-ink-400 pt-1">
        {axesCount === 0
          ? 'unscoped · all projects · all users'
          : `${axesCount} scope ${axesCount === 1 ? 'axis' : 'axes'} active`}
      </div>
    </div>
  );
}
