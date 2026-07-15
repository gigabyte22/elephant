import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner, LoadingBanner } from '../components/StateBanner.tsx';
import {
  CosmosCanvas,
  type CosmosSettings,
  type FlyTarget,
} from '../components/graph/CosmosCanvas.tsx';
import {
  CosmosHints,
  CosmosInspectorPanel,
  CosmosLeftPanel,
  UtilitiesPanel,
} from '../components/graph/CosmosPanels.tsx';
import { GraphCanvas } from '../components/graph/GraphCanvas.tsx';
import { NodeInspector } from '../components/graph/NodeInspector.tsx';
import { SearchPanel } from '../components/graph/SearchPanel.tsx';
import { useGraphNeighborhood } from '../hooks/useGraphNeighborhood.ts';
import { useGraphOverview } from '../hooks/useGraphOverview.ts';
import { useIsDesktop } from '../hooks/useMediaQuery.ts';
import { type GalaxyMeta, buildCosmos } from '../lib/cosmos.ts';

// Graph page with two modes:
//   cosmos — the whole memory at once. Louvain communities render as galaxies
//            (glowing core + orbiting members); floating panels handle search,
//            view-by, filters, and inspection.
//   focus  — the original neighborhood explorer (search rail / sigma canvas /
//            inspector rail), reached by double-clicking a node in the cosmos
//            or via the header toggle.

type Mode = 'cosmos' | 'focus';

// Raw conversation layers hidden from the cosmos by default (Option A). These
// are the high-volume, low-abstraction node kinds whose sheer count otherwise
// drowns the knowledge graph. Reachable on demand via the "raw layers" toggle
// and always via focus-mode neighborhoods.
const RAW_LAYER_KINDS = ['chunk', 'knowledge_chunk', 'episode', 'observation'];

export function GraphExplorer() {
  const [mode, setMode] = useState<Mode>('cosmos');
  const desktop = useIsDesktop();

  // Mobile bottom-sheet toggles (rails are always visible on desktop).
  const [locateOpen, setLocateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);

  // --- focus mode state ---
  const [rootId, setRootId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [depth, setDepth] = useState<1 | 2>(1);
  const neighborhood = useGraphNeighborhood({ nodeId: rootId, depth, maxNodes: 150 });

  // Deep link: /graph?focus=<nodeId> (used by the Entities ledger) opens the
  // focus explorer on that node directly.
  useEffect(() => {
    const focus = new URLSearchParams(window.location.search).get('focus');
    if (focus) {
      setRootId(focus);
      setSelectedId(focus);
      setMode('focus');
    }
  }, []);

  // --- cosmos mode state ---
  const [cosmosSelected, setCosmosSelected] = useState<string | null>(null);
  // Utilities start open on desktop only — on a phone the canvas is the point.
  const [utilitiesOpen, setUtilitiesOpen] = useState(desktop);
  const [flyTarget, setFlyTarget] = useState<FlyTarget | null>(null);
  const [cosmosSettings, setCosmosSettings] = useState<CosmosSettings>({
    viewBy: 'community',
    hiddenKinds: [],
    showRawLayers: false,
    orbit: true,
    orbitSpeed: 1,
    edgeOpacity: 1,
    interGalaxy: true,
    galaxyLabels: true,
  });
  const patchSettings = useCallback(
    (patch: Partial<CosmosSettings>) => setCosmosSettings((s) => ({ ...s, ...patch })),
    [],
  );

  // Option A default: the cosmos is a knowledge map (entities/facts/insights/…).
  // Raw conversation layers are dropped server-side so a few high-count chunks
  // can't crowd out everything meaningful; the toggle pulls them back in.
  const excludeKinds = cosmosSettings.showRawLayers ? [] : RAW_LAYER_KINDS;
  const overview = useGraphOverview(1200, mode === 'cosmos', excludeKinds);
  const build = useMemo(
    () => (overview.data && overview.data.nodes.length > 0 ? buildCosmos(overview.data) : null),
    [overview.data],
  );

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of overview.data?.nodes ?? []) {
      counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count);
  }, [overview.data]);

  const fly = useCallback((id: string, ratio: number) => {
    setFlyTarget((prev) => ({ id, ratio, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const handleDive = useCallback((id: string) => {
    setRootId(id);
    setSelectedId(id);
    setMode('focus');
  }, []);

  const handleFlyToGalaxy = useCallback(
    (g: GalaxyMeta) => {
      if (g.coreId) {
        fly(g.coreId, 0.32);
      } else if (build) {
        // The dust belt has no core — widen out to see the whole ring.
        fly(
          build.graph
            .nodes()
            .find((n) => build.graph.getNodeAttribute(n, 'community') === '__dust') ?? '',
          1.0,
        );
      }
    },
    [fly, build],
  );

  const handleSearchHit = useCallback(
    (id: string) => {
      if (build?.graph.hasNode(id)) {
        setCosmosSelected(id);
        fly(id, 0.28);
      } else {
        // Not part of the overview snapshot (truncated / superseded) — open
        // it in the focus explorer instead.
        handleDive(id);
      }
    },
    [build, fly, handleDive],
  );

  // 'u' toggles utilities, escape clears the cosmos selection.
  useEffect(() => {
    if (mode !== 'cosmos') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (e.key === 'u' || e.key === 'U') setUtilitiesOpen((v) => !v);
      if (e.key === 'Escape') setCosmosSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  function handleFocusSelect(id: string) {
    if (id === rootId) {
      setSelectedId(id);
      return;
    }
    setRootId(id);
    setSelectedId(id);
  }

  const selectedAttrs =
    cosmosSelected && build?.graph.hasNode(cosmosSelected)
      ? build.graph.getNodeAttributes(cosmosSelected)
      : null;
  const selectedGalaxy = selectedAttrs
    ? (build?.galaxies.find((g) => g.community === selectedAttrs.community) ?? null)
    : null;

  return (
    <div className="-mx-4 -my-6 flex min-h-0 flex-1 flex-col sm:-mx-6 md:-mx-10 md:-my-10">
      <PageHeader
        mode={mode}
        onModeChange={setMode}
        depth={depth}
        onDepthChange={setDepth}
        focusStats={{
          truncated: neighborhood.data?.truncated ?? false,
          nodeCount: neighborhood.data?.nodes.length ?? 0,
          edgeCount: neighborhood.data?.edges.length ?? 0,
        }}
        cosmosStats={{
          nodeCount: overview.data?.nodes.length ?? 0,
          edgeCount: overview.data?.edges.length ?? 0,
          galaxyCount: build?.galaxies.filter((g) => !g.isDust).length ?? 0,
        }}
      />

      {mode === 'cosmos' ? (
        <div className="relative flex-1 overflow-hidden">
          {overview.isError ? (
            <div className="p-10">
              <ErrorBanner message={(overview.error as Error).message} />
            </div>
          ) : overview.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <LoadingBanner label="charting the cosmos…" />
            </div>
          ) : !build ? (
            <CosmosIdleState />
          ) : (
            <>
              <CosmosCanvas
                build={build}
                settings={cosmosSettings}
                selectedId={cosmosSelected}
                onSelect={setCosmosSelected}
                onDive={handleDive}
                flyTarget={flyTarget}
              />
              {(desktop || locateOpen) && (
                <CosmosLeftPanel
                  payload={overview.data}
                  galaxies={build.galaxies}
                  viewBy={cosmosSettings.viewBy}
                  onViewBy={(viewBy) => patchSettings({ viewBy })}
                  onFlyToGalaxy={(g) => {
                    setLocateOpen(false);
                    handleFlyToGalaxy(g);
                  }}
                  onPickSearchHit={(id) => {
                    setLocateOpen(false);
                    handleSearchHit(id);
                  }}
                  variant={desktop ? 'rail' : 'sheet'}
                  onClose={() => setLocateOpen(false)}
                />
              )}
              {cosmosSelected && selectedAttrs ? (
                <CosmosInspectorPanel
                  nodeId={cosmosSelected}
                  kind={String(selectedAttrs.kind)}
                  label={String(selectedAttrs.label)}
                  galaxyName={selectedGalaxy?.name ?? null}
                  galaxyColor={selectedGalaxy?.color ?? null}
                  onClose={() => setCosmosSelected(null)}
                  onDive={handleDive}
                  variant={desktop ? 'rail' : 'sheet'}
                />
              ) : (
                utilitiesOpen && (
                  <UtilitiesPanel
                    settings={cosmosSettings}
                    onChange={patchSettings}
                    kinds={kinds}
                    onClose={() => setUtilitiesOpen(false)}
                    variant={desktop ? 'rail' : 'sheet'}
                  />
                )
              )}
              {!desktop && !cosmosSelected && !locateOpen && !utilitiesOpen && (
                <div className="pointer-events-none absolute inset-x-4 bottom-4 flex justify-between">
                  <ChipButton label="locate" onClick={() => setLocateOpen(true)} />
                  <ChipButton label="utilities" onClick={() => setUtilitiesOpen(true)} />
                </div>
              )}
              <CosmosHints utilitiesOpen={utilitiesOpen} />
            </>
          )}
        </div>
      ) : (
        <div className="relative grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[20rem_1fr_22rem]">
          {desktop && <SearchPanel selectedId={selectedId} onSelect={handleFocusSelect} />}
          <div className="relative">
            {rootId === null ? (
              <FocusIdleState />
            ) : neighborhood.isError ? (
              <div className="p-10">
                <ErrorBanner message={(neighborhood.error as Error).message} />
              </div>
            ) : (
              <>
                {neighborhood.isLoading && (
                  <div className="absolute left-7 top-5 z-10">
                    <LoadingBanner label="resolving neighborhood…" />
                  </div>
                )}
                <GraphCanvas
                  payload={neighborhood.data}
                  selectedId={selectedId}
                  onSelect={handleFocusSelect}
                />
              </>
            )}
          </div>
          {desktop && <NodeInspector payload={neighborhood.data} selectedId={selectedId} />}

          {!desktop && (
            <>
              {!searchOpen && !inspectOpen && (
                <div className="pointer-events-none absolute inset-x-4 bottom-4 flex justify-between">
                  <ChipButton label="search" onClick={() => setSearchOpen(true)} />
                  <ChipButton
                    label="inspect"
                    onClick={() => setInspectOpen(true)}
                    disabled={selectedId === null}
                  />
                </div>
              )}
              {searchOpen && (
                <MobileSheet title="graph · search" onClose={() => setSearchOpen(false)}>
                  <SearchPanel
                    selectedId={selectedId}
                    onSelect={(id) => {
                      setSearchOpen(false);
                      handleFocusSelect(id);
                    }}
                  />
                </MobileSheet>
              )}
              {inspectOpen && (
                <MobileSheet title="inspector" onClose={() => setInspectOpen(false)}>
                  <NodeInspector payload={neighborhood.data} selectedId={selectedId} />
                </MobileSheet>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Floating glass chip — the mobile affordance for opening a bottom sheet
// over the canvas.
function ChipButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="pointer-events-auto border border-hairline-strong bg-ink-900/80 px-3 py-1.5 font-mono text-2xs uppercase tracking-widest text-ink-200 shadow-panel backdrop-blur-md transition-colors hover:border-accent-500 hover:text-accent-300 disabled:cursor-not-allowed disabled:text-ink-500"
    >
      {label} ·
    </button>
  );
}

function MobileSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex h-[60vh] flex-col border-t border-hairline-strong bg-ink-900/90 shadow-panel backdrop-blur-md">
      <header className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <span className="label-meta">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-sm text-ink-400 hover:text-ink-100"
          aria-label={`close ${title}`}
        >
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

interface HeaderProps {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  depth: 1 | 2;
  onDepthChange: (d: 1 | 2) => void;
  focusStats: { truncated: boolean; nodeCount: number; edgeCount: number };
  cosmosStats: { nodeCount: number; edgeCount: number; galaxyCount: number };
}

function PageHeader({
  mode,
  onModeChange,
  depth,
  onDepthChange,
  focusStats,
  cosmosStats,
}: HeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-hairline px-4 py-4 sm:px-6 md:px-10 md:py-5">
      <div className="flex items-baseline gap-4 md:gap-5">
        <span className="font-mono text-2xs tabular-nums tracking-widest text-accent-500">02</span>
        <h1 className="font-cinema text-3xl font-light uppercase leading-none tracking-wide text-ink-100 chroma md:text-[3.25rem]">
          {mode === 'cosmos' ? 'memory cosmos' : 'graph explorer'}
        </h1>
      </div>
      <div className="flex items-center gap-4 md:gap-6">
        {mode === 'cosmos' ? (
          <div className="hidden items-center gap-6 md:flex">
            <Stat label="memories" value={cosmosStats.nodeCount} />
            <Stat label="links" value={cosmosStats.edgeCount} />
            <Stat label="galaxies" value={cosmosStats.galaxyCount} />
          </div>
        ) : (
          <>
            <div className="hidden items-center gap-6 md:flex">
              <Stat label="nodes" value={focusStats.nodeCount} />
              <Stat label="edges" value={focusStats.edgeCount} />
            </div>
            {focusStats.truncated && (
              <span className="hidden font-mono text-2xs uppercase tracking-widest text-accent-500 md:inline">
                truncated
              </span>
            )}
            <div className="flex items-center gap-2 border border-hairline-strong">
              <span className="label-meta pl-2.5">depth</span>
              {[1, 2].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => onDepthChange(d as 1 | 2)}
                  className={`px-2.5 py-1 font-mono text-2xs ${
                    depth === d
                      ? 'bg-accent-500/10 text-accent-300'
                      : 'text-ink-400 hover:text-ink-100'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="flex items-center border border-hairline-strong">
          {(['cosmos', 'focus'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={`px-3 py-1 font-mono text-2xs uppercase tracking-widest transition-colors ${
                mode === m ? 'bg-accent-500/10 text-accent-300' : 'text-ink-400 hover:text-ink-100'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="label-key">{label}</span>
      <span className="num text-sm text-ink-100">{value}</span>
    </span>
  );
}

function CosmosIdleState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        <span className="label-meta block pb-3">void</span>
        <p className="text-sm leading-relaxed text-ink-300">
          No knowledge yet — once facts, entities, and insights accumulate, they will cluster into
          galaxies here. Raw conversation (chunks, episodes) is hidden by default; enable “raw
          layers” in utilities to see it.
        </p>
      </div>
    </div>
  );
}

function FocusIdleState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        <span className="label-meta block pb-3">canvas idle</span>
        <p className="text-sm leading-relaxed text-ink-300">
          Pick a fact, entity, chunk, or procedure from the search panel to load its neighborhood
          here.
        </p>
      </div>
    </div>
  );
}
