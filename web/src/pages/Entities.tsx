import { Link } from 'wouter';
import { CompositionBar } from '../components/CompositionBar.tsx';
import { LedgerScroll } from '../components/LedgerScroll.tsx';
import { PageHeading } from '../components/PageHeading.tsx';
import { RefBar } from '../components/RefBar.tsx';
import { ErrorBanner, LoadingBanner } from '../components/StateBanner.tsx';
import { useEntityTypes } from '../hooks/useEntityTypes.ts';
import { useScope } from '../hooks/useScope.ts';
import { useTopEntities } from '../hooks/useTopEntities.ts';
import { fmtCount } from '../lib/format.ts';

// Entities — the hubs of the knowledge graph, ranked by how many live facts
// they anchor. A tonal composition bar breaks the global entity population
// down by type; each row links into the graph explorer's focus mode.

const GRID = 'grid-cols-[2.5rem_1fr_9rem_10rem]';

export function Entities() {
  const scope = useScope();
  const entities = useTopEntities({ scope, limit: 100 });
  const types = useEntityTypes();

  const items = entities.data?.items ?? [];
  const max = items.reduce((m, e) => Math.max(m, e.factCount), 0) || 1;

  return (
    <div className="mx-auto max-w-7xl pb-20">
      <PageHeading
        rank={4}
        title="entities"
        right={
          entities.data ? (
            <span className="label-key">top {items.length} by anchored facts</span>
          ) : undefined
        }
      />

      {types.data && types.data.items.length > 0 && (
        <section className="mb-8 border-b border-hairline pb-8">
          <header className="flex items-center justify-between pb-5">
            <span className="label-meta">entities · by type</span>
            <span className="label-key text-ink-500">
              {fmtCount(types.data.items.reduce((a, b) => a + b.count, 0))} total
            </span>
          </header>
          <CompositionBar
            items={types.data.items.map((t) => ({
              key: t.type,
              label: t.type,
              count: t.count,
            }))}
          />
        </section>
      )}

      {entities.isError && <ErrorBanner message={(entities.error as Error).message} />}
      {entities.isLoading && <LoadingBanner label="ranking entities…" />}

      {entities.data && (
        <>
          <LedgerScroll minWidth="34rem">
            <RowHeader />
            {items.length === 0 ? (
              <div className="border-b border-hairline py-12 text-center font-mono text-2xs uppercase tracking-widest text-ink-500">
                no entities anchor facts in the current scope
              </div>
            ) : (
              <ol>
                {items.map((e, i) => (
                  <li key={e.id}>
                    <Link
                      href={`/graph?focus=${encodeURIComponent(e.id)}`}
                      className={`grid ${GRID} items-baseline gap-5 border-b border-hairline py-3 hover:bg-white/[0.012]`}
                      title="open in graph explorer"
                    >
                      <span className="font-mono text-2xs tabular-nums text-ink-500">
                        {String(i + 1).padStart(3, '0')}
                      </span>
                      <span className="truncate text-sm text-ink-100">{e.name}</span>
                      <span className="truncate font-mono text-2xs uppercase tracking-widest text-cyan-400">
                        {e.type || 'unknown'}
                      </span>
                      <RefBar
                        pct={Math.max(2, Math.round((e.factCount / max) * 100))}
                        value={e.factCount}
                      />
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </LedgerScroll>
          <p className="pt-4 font-mono text-2xs uppercase tracking-widest text-ink-500">
            entities are global — scope filters the facts they anchor
          </p>
        </>
      )}
    </div>
  );
}

function RowHeader() {
  return (
    <div className={`grid ${GRID} gap-5 border-y border-hairline py-2`}>
      <span className="label-key">#</span>
      <span className="label-key">name</span>
      <span className="label-key">type</span>
      <span className="label-key">facts anchored</span>
    </div>
  );
}
