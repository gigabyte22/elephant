import { useState } from 'react';
import type { GraphEdge, GraphOverviewPayload } from '../../api/types.ts';
import { useGraphNeighborhood } from '../../hooks/useGraphNeighborhood.ts';
import { useGraphSearch } from '../../hooks/useGraphSearch.ts';
import { type GalaxyMeta, hexToRgba } from '../../lib/cosmos.ts';
import { fmtKindLabel, truncateText } from '../../lib/format.ts';
import { styleForKind } from '../../lib/kindStyle.ts';
import type { CosmosSettings } from './CosmosCanvas.tsx';

// Floating chrome for the cosmos view. Everything sits above the canvas as
// translucent "projected" panels: a left rail (search / view-by / galaxy
// index / stats), a right utilities panel, and an inspector that replaces the
// utilities panel while a node is selected.

const glass = 'border border-hairline-strong bg-ink-900/75 backdrop-blur-md shadow-panel';

// Panel placement: 'rail' floats at the canvas edges (desktop), 'sheet'
// docks to the bottom of the canvas (below md, toggled by glass chips).
export type PanelVariant = 'rail' | 'sheet';

// --- left rail ---------------------------------------------------------------

interface LeftPanelProps {
  payload: GraphOverviewPayload | undefined;
  galaxies: GalaxyMeta[];
  viewBy: 'community' | 'kind';
  onViewBy: (v: 'community' | 'kind') => void;
  onFlyToGalaxy: (g: GalaxyMeta) => void;
  onPickSearchHit: (id: string) => void;
  variant?: PanelVariant;
  onClose?: () => void;
}

export function CosmosLeftPanel({
  payload,
  galaxies,
  viewBy,
  onViewBy,
  onFlyToGalaxy,
  onPickSearchHit,
  variant = 'rail',
  onClose,
}: LeftPanelProps) {
  const [q, setQ] = useState('');
  const results = useGraphSearch(q, 8);
  const placement =
    variant === 'rail' ? 'bottom-5 left-5 top-5 w-64' : 'inset-x-0 bottom-0 h-[60vh]';

  return (
    <div
      className={`pointer-events-auto absolute ${placement} flex flex-col overflow-hidden ${glass}`}
    >
      {variant === 'sheet' && (
        <header className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
          <span className="label-meta">locate · galaxies</span>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-sm text-ink-400 hover:text-ink-100"
            aria-label="close locate panel"
          >
            ×
          </button>
        </header>
      )}
      <div className="relative border-b border-hairline px-4 py-3">
        {variant === 'rail' && <span className="label-meta block pb-1.5">locate</span>}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search memory…"
          className="w-full border-0 border-b border-hairline-strong bg-transparent px-0 pb-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
        />
        {q.trim().length > 0 && (
          <div className="absolute inset-x-0 top-full z-20 max-h-72 overflow-y-auto border border-hairline-strong bg-ink-900/95 backdrop-blur-md">
            {results.isLoading ? (
              <div className="px-4 py-3 font-mono text-2xs uppercase tracking-widest text-ink-500">
                searching…
              </div>
            ) : (results.data?.results.length ?? 0) === 0 ? (
              <div className="px-4 py-3 font-mono text-2xs uppercase tracking-widest text-ink-500">
                no hits
              </div>
            ) : (
              (results.data?.results ?? []).map((r) => (
                <button
                  key={`${r.kind}:${r.id}`}
                  type="button"
                  onClick={() => {
                    onPickSearchHit(r.id);
                    setQ('');
                  }}
                  className="block w-full border-b border-hairline px-4 py-2 text-left hover:bg-white/[0.03]"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: styleForKind(r.kind).color }}
                      aria-hidden
                    />
                    <span className="font-mono text-2xs uppercase tracking-widest text-ink-400">
                      {fmtKindLabel(r.kind)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-ink-100">{r.label}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="border-b border-hairline px-4 py-3">
        <span className="label-meta block pb-2">view by</span>
        <div className="flex gap-1.5">
          {(['community', 'kind'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onViewBy(v)}
              className={`border px-2.5 py-1 font-mono text-2xs uppercase tracking-widest transition-colors ${
                viewBy === v
                  ? 'border-accent-500/60 bg-accent-500/10 text-accent-300'
                  : 'border-hairline-strong text-ink-400 hover:text-ink-100'
              }`}
            >
              {v === 'community' ? 'galaxy' : 'kind'}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        <span className="label-meta block px-3 pb-1 pt-1">
          galaxies · {galaxies.filter((g) => !g.isDust).length}
        </span>
        {galaxies.map((g) => (
          <button
            key={g.community}
            type="button"
            onClick={() => onFlyToGalaxy(g)}
            className="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-white/[0.03]"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: g.color, boxShadow: `0 0 8px ${hexToRgba(g.color, 0.7)}` }}
              aria-hidden
            />
            <span className="truncate font-mono text-2xs uppercase tracking-widest text-ink-300 group-hover:text-ink-100">
              {g.name}
            </span>
            <span className="num ml-auto text-2xs text-ink-500">{g.count}</span>
          </button>
        ))}
      </div>

      <div className="border-t border-hairline px-4 py-3">
        <span className="label-meta block pb-2">stats</span>
        <dl className="space-y-1">
          <StatRow k="memories" v={payload?.nodes.length ?? 0} />
          <StatRow k="links" v={payload?.edges.length ?? 0} />
          <StatRow k="galaxies" v={galaxies.filter((g) => !g.isDust).length} />
        </dl>
        {payload?.truncated && (
          <p className="mt-2 font-mono text-2xs uppercase tracking-widest text-accent-500">
            showing {payload.nodes.length} of {payload.totalNodes}
          </p>
        )}
      </div>
    </div>
  );
}

function StatRow({ k, v }: { k: string; v: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="label-key">{k}</dt>
      <dd className="num text-xs text-ink-100">{v}</dd>
    </div>
  );
}

// --- utilities panel -----------------------------------------------------------

interface UtilitiesProps {
  settings: CosmosSettings;
  onChange: (patch: Partial<CosmosSettings>) => void;
  kinds: Array<{ kind: string; count: number }>;
  onClose: () => void;
  variant?: PanelVariant;
}

export function UtilitiesPanel({
  settings,
  onChange,
  kinds,
  onClose,
  variant = 'rail',
}: UtilitiesProps) {
  const hidden = new Set(settings.hiddenKinds);
  const placement =
    variant === 'rail'
      ? 'right-5 top-5 w-60 max-h-[calc(100%-2.5rem)]'
      : 'inset-x-0 bottom-0 max-h-[60vh]';
  return (
    <div className={`pointer-events-auto absolute ${placement} ${glass} overflow-y-auto`}>
      <header className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <span className="label-meta">
          utilities <kbd className="ml-1 text-ink-500">(u)</kbd>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-xs text-ink-400 hover:text-ink-100"
          aria-label="close utilities"
        >
          ×
        </button>
      </header>

      <Section title="motion">
        <ToggleRow
          label={settings.orbit ? 'orbiting' : 'frozen'}
          on={settings.orbit}
          onToggle={() => onChange({ orbit: !settings.orbit })}
        />
        <SliderRow
          label="orbit speed"
          min={0.2}
          max={3}
          step={0.1}
          value={settings.orbitSpeed}
          onChange={(v) => onChange({ orbitSpeed: v })}
        />
      </Section>

      <Section title="links">
        <SliderRow
          label="opacity"
          min={0}
          max={2}
          step={0.1}
          value={settings.edgeOpacity}
          onChange={(v) => onChange({ edgeOpacity: v })}
        />
        <ToggleRow
          label="inter-galaxy links"
          on={settings.interGalaxy}
          onToggle={() => onChange({ interGalaxy: !settings.interGalaxy })}
        />
      </Section>

      <Section title="labels">
        <ToggleRow
          label="galaxy labels"
          on={settings.galaxyLabels}
          onToggle={() => onChange({ galaxyLabels: !settings.galaxyLabels })}
        />
      </Section>

      <Section title="layers">
        <ToggleRow
          label={settings.showRawLayers ? 'raw layers shown' : 'raw layers hidden'}
          on={settings.showRawLayers}
          onToggle={() => onChange({ showRawLayers: !settings.showRawLayers })}
        />
        <p className="font-mono text-2xs leading-relaxed text-ink-500">
          chunks · episodes · observations
        </p>
      </Section>

      <Section title="filters">
        <div className="flex flex-wrap gap-1.5">
          {kinds.map(({ kind, count }) => {
            const off = hidden.has(kind);
            const style = styleForKind(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() =>
                  onChange({
                    hiddenKinds: off
                      ? settings.hiddenKinds.filter((k) => k !== kind)
                      : [...settings.hiddenKinds, kind],
                  })
                }
                className={`flex items-center gap-1.5 border px-2 py-1 font-mono text-2xs uppercase tracking-widest transition-colors ${
                  off ? 'border-hairline text-ink-500' : 'border-hairline-strong text-ink-200'
                }`}
                title={off ? 'show' : 'hide'}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: off ? '#3D3A4C' : style.color }}
                  aria-hidden
                />
                {fmtKindLabel(kind)}
                <span className="num text-ink-500">{count}</span>
              </button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-hairline px-4 py-3 last:border-b-0">
      <h3 className="label-meta pb-2.5">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function ToggleRow({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-3 text-left"
    >
      <span className="font-mono text-2xs uppercase tracking-widest text-ink-300">{label}</span>
      <span
        className={`relative h-3.5 w-7 shrink-0 border transition-colors ${
          on ? 'border-accent-500/70 bg-accent-500/20' : 'border-hairline-strong bg-transparent'
        }`}
      >
        <span
          className={`absolute top-0.5 h-2 w-2 transition-all ${
            on ? 'left-[calc(100%-0.625rem)] bg-accent-400 shadow-halo-sm' : 'left-0.5 bg-ink-500'
          }`}
        />
      </span>
    </button>
  );
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between pb-1">
        <span className="font-mono text-2xs uppercase tracking-widest text-ink-300">{label}</span>
        <span className="num text-2xs text-ink-400">{value.toFixed(1)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none bg-ink-600 accent-accent-500"
      />
    </label>
  );
}

// --- inspector -------------------------------------------------------------------

interface InspectorProps {
  nodeId: string;
  kind: string;
  label: string;
  galaxyName: string | null;
  galaxyColor: string | null;
  onClose: () => void;
  onDive: (id: string) => void;
  variant?: PanelVariant;
}

export function CosmosInspectorPanel({
  nodeId,
  kind,
  label,
  galaxyName,
  galaxyColor,
  onClose,
  onDive,
  variant = 'rail',
}: InspectorProps) {
  const detail = useGraphNeighborhood({ nodeId, depth: 1, maxNodes: 60 });
  const node = detail.data?.nodes.find((n) => n.id === nodeId);
  const edges: GraphEdge[] = (detail.data?.edges ?? []).filter(
    (e) => e.source === nodeId || e.target === nodeId,
  );
  const placement =
    variant === 'rail' ? 'bottom-5 right-5 top-5 w-80' : 'inset-x-0 bottom-0 h-[65vh]';

  return (
    <div
      className={`pointer-events-auto absolute ${placement} flex flex-col overflow-hidden ${glass}`}
    >
      <header className="border-b border-hairline px-5 py-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: styleForKind(kind).color }}
              aria-hidden
            />
            <span className="font-mono text-2xs uppercase tracking-widest text-ink-300">
              {fmtKindLabel(kind)}
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-sm text-ink-400 hover:text-ink-100"
            aria-label="close inspector"
          >
            ×
          </button>
        </div>
        <p className="mt-2 break-words text-sm leading-relaxed text-ink-100">{label}</p>
        {galaxyName && (
          <p className="mt-2 flex items-center gap-2 font-mono text-2xs uppercase tracking-widest text-ink-400">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: galaxyColor ?? '#55506A' }}
              aria-hidden
            />
            {galaxyName}
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail.isLoading ? (
          <div className="px-5 py-4 font-mono text-2xs uppercase tracking-widest text-ink-500">
            resolving…
          </div>
        ) : (
          <>
            {node && (
              <section className="border-b border-hairline px-5 py-4">
                <h3 className="label-meta pb-3">properties</h3>
                <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5">
                  {Object.entries(node.props)
                    .filter(([k]) => k !== 'id' && k !== 'kind')
                    .slice(0, 12)
                    .map(([k, v]) => (
                      <PropRow key={k} k={k} v={v} />
                    ))}
                </dl>
              </section>
            )}
            {edges.length > 0 && (
              <section className="px-5 py-4">
                <h3 className="label-meta pb-3">links · {edges.length}</h3>
                <ol className="space-y-1.5">
                  {edges.slice(0, 12).map((e) => {
                    const outgoing = e.source === nodeId;
                    const otherId = outgoing ? e.target : e.source;
                    const other = detail.data?.nodes.find((n) => n.id === otherId);
                    return (
                      <li key={e.id} className="flex items-baseline gap-2">
                        <span className="font-mono text-2xs text-accent-400">
                          {outgoing ? '→' : '←'}
                        </span>
                        <span className="shrink-0 font-mono text-2xs uppercase tracking-widest text-ink-400">
                          {e.type}
                        </span>
                        <span
                          className="ml-auto truncate text-2xs text-ink-200"
                          title={other?.label}
                        >
                          {truncateText(other?.label ?? otherId, 24)}
                        </span>
                      </li>
                    );
                  })}
                  {edges.length > 12 && (
                    <li className="font-mono text-2xs text-ink-500">+{edges.length - 12} more</li>
                  )}
                </ol>
              </section>
            )}
          </>
        )}
      </div>

      <footer className="border-t border-hairline px-5 py-3">
        <button
          type="button"
          onClick={() => onDive(nodeId)}
          className="w-full border border-accent-500/50 bg-accent-500/10 px-3 py-2 font-mono text-2xs uppercase tracking-widest text-accent-300 transition-colors hover:bg-accent-500/20"
        >
          dive into focus view →
        </button>
      </footer>
    </div>
  );
}

function PropRow({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt className="break-words font-mono text-2xs uppercase tracking-widest text-ink-400">{k}</dt>
      <dd className="break-words font-mono text-2xs text-ink-100">
        {v === null ? <span className="text-ink-500">null</span> : String(v)}
      </dd>
    </>
  );
}

// --- hint bar --------------------------------------------------------------------

export function CosmosHints({ utilitiesOpen }: { utilitiesOpen: boolean }) {
  // Keyboard/mouse affordances only exist on desktop; touch users get the
  // native sigma gestures (pinch zoom / drag pan / tap inspect).
  return (
    <div
      className={`pointer-events-none absolute bottom-5 left-1/2 hidden -translate-x-1/2 px-3 py-1.5 font-mono text-2xs text-ink-500 md:block ${glass}`}
    >
      scroll <span className="text-ink-300">zoom</span> · drag{' '}
      <span className="text-ink-300">pan</span> · click{' '}
      <span className="text-ink-300">inspect</span> · 2×click{' '}
      <span className="text-ink-300">dive</span> · <span className="text-ink-300">u</span>{' '}
      {utilitiesOpen ? 'hide' : 'show'} utilities
    </div>
  );
}
