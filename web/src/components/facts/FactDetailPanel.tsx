import type { ReactNode } from 'react';
import type { TopFact, WireFact } from '../../api/types.ts';
import { useGraphNeighborhood } from '../../hooks/useGraphNeighborhood.ts';
import { useSupersedeChain } from '../../hooks/useSupersedeChain.ts';
import { fmtCount, fmtRelativeTime } from '../../lib/format.ts';
import { DetailPanel } from '../DetailPanel.tsx';

// Full-fact drill-down hosted in the shared DetailPanel. Shows everything the
// ledger row truncates: full content, scores, validity window, provenance,
// linked entities (names resolved via the graph neighborhood), and the
// supersede lineage oldest → newest with the open fact marked.

interface Props {
  fact: TopFact | null;
  onClose: () => void;
}

export function FactDetailPanel({ fact, onClose }: Props) {
  return (
    <DetailPanel
      open={fact !== null}
      onClose={onClose}
      title={
        <div className="flex items-baseline gap-3">
          <span className="label-meta">fact</span>
          <span className="truncate font-mono text-2xs text-ink-500">{fact?.id}</span>
        </div>
      }
    >
      {fact && <FactDetailBody fact={fact} />}
    </DetailPanel>
  );
}

// exempt (importance ≥ 0.75) reads cyan/durable; below the at-risk retention
// floor reads rust; otherwise neutral. Mirrors the Facts ledger tone.
function retentionTone(fact: TopFact): 'cyan' | 'rust' | undefined {
  if (fact.importance >= 0.75) return 'cyan';
  if (fact.retention < 0.2) return 'rust';
  return undefined;
}

function FactDetailBody({ fact }: { fact: TopFact }) {
  return (
    <div className="flex flex-col gap-7">
      <p className="text-sm leading-relaxed text-ink-100">{fact.content}</p>

      <div className="grid grid-cols-4 gap-4 border-y border-hairline py-4">
        <Readout label="imp" value={fact.importance.toFixed(2)} />
        <Readout label="conf" value={fact.confidence.toFixed(2)} />
        <Readout label="ret" value={fact.retention.toFixed(2)} tone={retentionTone(fact)} />
        <Readout label="refs" value={fmtCount(fact.refCount)} />
      </div>

      <dl className="flex flex-col gap-2.5">
        <MetaRow label="category">
          {fact.category ? (
            <span className="border border-hairline px-2 py-0.5 font-mono text-2xs uppercase tracking-widest text-ink-100">
              {fact.category}
            </span>
          ) : (
            <Dim>uncategorized</Dim>
          )}
        </MetaRow>
        <MetaRow label="valid">
          <span className="num text-xs text-ink-100">
            {fmtDate(fact.validFrom)} → {fact.validTo ? fmtDate(fact.validTo) : 'open'}
          </span>
        </MetaRow>
        <MetaRow label="recorded">
          <span className="num text-xs text-ink-100">{fmtDate(fact.recordedAt)}</span>
        </MetaRow>
        <MetaRow label="last hit">
          <span className="num text-xs text-ink-100">{fmtRelativeTime(fact.lastReferencedAt)}</span>
        </MetaRow>
        {fact.projectId && (
          <MetaRow label="project">
            <span className="font-mono text-xs text-ink-100">{fact.projectId}</span>
          </MetaRow>
        )}
        {fact.userId && (
          <MetaRow label="user">
            <span className="font-mono text-xs text-ink-100">{fact.userId}</span>
          </MetaRow>
        )}
        {fact.sourceEpisodeId && (
          <MetaRow label="episode">
            <span className="truncate font-mono text-2xs text-ink-400">{fact.sourceEpisodeId}</span>
          </MetaRow>
        )}
      </dl>

      <EntitySection fact={fact} />
      <LineageSection fact={fact} />
    </div>
  );
}

// --- entities ---------------------------------------------------------------

function EntitySection({ fact }: { fact: TopFact }) {
  // Resolve entity names through the 1-hop neighborhood; the fact row itself
  // only carries entity ids.
  const hood = useGraphNeighborhood({
    nodeId: fact.entities.length > 0 ? fact.id : null,
    depth: 1,
    maxNodes: 60,
  });
  const entities = (hood.data?.nodes ?? []).filter((n) => n.kind === 'entity');

  return (
    <Section label={`entities · ${fact.entities.length}`}>
      {fact.entities.length === 0 ? (
        <Dim>none linked</Dim>
      ) : hood.isLoading ? (
        <Dim>resolving…</Dim>
      ) : entities.length === 0 ? (
        <Dim>{fact.entities.length} linked (names unavailable)</Dim>
      ) : (
        <div className="flex flex-wrap gap-2">
          {entities.map((e) => (
            <span
              key={e.id}
              className="border border-hairline px-2 py-0.5 font-mono text-2xs text-cyan-400"
            >
              {e.label}
            </span>
          ))}
        </div>
      )}
    </Section>
  );
}

// --- lineage ----------------------------------------------------------------

function LineageSection({ fact }: { fact: TopFact }) {
  const chain = useSupersedeChain(fact.id);
  const items = chain.data?.chain ?? [];

  return (
    <Section label="lineage">
      {chain.isLoading ? (
        <Dim>walking supersede chain…</Dim>
      ) : chain.isError ? (
        <Dim>lineage unavailable</Dim>
      ) : items.length <= 1 ? (
        <Dim>no revisions — original fact</Dim>
      ) : (
        <ol className="flex flex-col">
          {items.map((link, i) => (
            <LineageRow key={link.id} link={link} index={i} current={link.id === fact.id} />
          ))}
        </ol>
      )}
    </Section>
  );
}

function LineageRow({
  link,
  index,
  current,
}: {
  link: WireFact;
  index: number;
  current: boolean;
}) {
  return (
    <li className="relative flex gap-4 border-l border-hairline-strong pb-4 pl-4 last:pb-0">
      {current && (
        <span
          className="absolute -left-px top-1 h-4 w-0.5 bg-accent-500"
          style={{ boxShadow: '0 0 10px rgba(255,92,138,0.75)' }}
          aria-hidden
        />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-2xs tabular-nums text-ink-500">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className="num text-2xs text-ink-400">{fmtDate(link.validFrom)}</span>
          {current && <span className="label-meta text-accent-300">this fact</span>}
          {!current && link.validTo === null && (
            <span className="label-meta text-cyan-400">live</span>
          )}
        </div>
        <p className={`text-xs leading-relaxed ${current ? 'text-ink-100' : 'text-ink-400'}`}>
          {link.content}
        </p>
      </div>
    </li>
  );
}

// --- primitives ---------------------------------------------------------------

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="label-key border-b border-hairline pb-2">{label}</h3>
      <div className="pt-3">{children}</div>
    </section>
  );
}

function Readout({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'cyan' | 'rust';
}) {
  const color = tone === 'cyan' ? 'text-cyan-400' : tone === 'rust' ? 'text-rust' : 'text-ink-100';
  return (
    <div className="flex flex-col gap-1">
      <span className="label-key">{label}</span>
      <span className={`num text-lg ${color}`}>{value}</span>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="label-key shrink-0">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Dim({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-2xs uppercase tracking-widest text-ink-500">{children}</span>
  );
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}
