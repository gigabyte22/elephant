import type { GraphEdge, GraphNeighborhoodPayload, GraphNode } from '../../api/types.ts';
import { fmtKindLabel } from '../../lib/format.ts';
import { styleForKind } from '../../lib/kindStyle.ts';

// Right rail of Graph Explorer. Renders the selected node's properties +
// connected edges, grouped by direction. Property values are rendered as
// monospaced rows; very long strings are clamped by the backend already.

interface Props {
  payload: GraphNeighborhoodPayload | undefined;
  selectedId: string | null;
}

export function NodeInspector({ payload, selectedId }: Props) {
  if (!payload || !selectedId) {
    return (
      <aside className="flex h-full w-full flex-col border-l border-hairline px-7 py-7 md:w-[22rem]">
        <span className="label-meta">inspector</span>
        <div className="mt-6 font-mono text-2xs uppercase tracking-widest text-ink-500">
          no node selected
        </div>
      </aside>
    );
  }

  const node = payload.nodes.find((n) => n.id === selectedId);
  if (!node) {
    return (
      <aside className="flex h-full w-full flex-col border-l border-hairline px-7 py-7 md:w-[22rem]">
        <span className="label-meta">inspector</span>
        <div className="mt-6 font-mono text-2xs uppercase tracking-widest text-ink-500">
          node {selectedId.slice(0, 8)}… missing from payload
        </div>
      </aside>
    );
  }

  const incoming: Array<{ edge: GraphEdge; other: GraphNode | undefined }> = [];
  const outgoing: Array<{ edge: GraphEdge; other: GraphNode | undefined }> = [];
  for (const edge of payload.edges) {
    if (edge.source === selectedId) {
      outgoing.push({ edge, other: payload.nodes.find((n) => n.id === edge.target) });
    } else if (edge.target === selectedId) {
      incoming.push({ edge, other: payload.nodes.find((n) => n.id === edge.source) });
    }
  }

  const style = styleForKind(node.kind);

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-l border-hairline md:w-[22rem]">
      <header className="border-b border-hairline px-7 py-6">
        <div className="flex items-center gap-2.5">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: style.color }}
            aria-hidden
          />
          <span className="font-mono text-2xs uppercase tracking-widest text-ink-300">
            {fmtKindLabel(node.kind)}
          </span>
        </div>
        <div className="mt-2 break-words text-base text-ink-100">{node.label}</div>
        <div className="mt-1 font-mono text-2xs text-ink-500">{node.id}</div>
      </header>

      <Section title="properties">
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2">
          {Object.entries(node.props)
            .filter(([k]) => k !== 'id' && k !== 'kind')
            .map(([k, v]) => (
              <PropRow key={k} k={k} v={v} />
            ))}
        </dl>
      </Section>

      {outgoing.length > 0 && (
        <Section title={`outgoing · ${outgoing.length}`}>
          <EdgeList rows={outgoing} arrow="→" />
        </Section>
      )}

      {incoming.length > 0 && (
        <Section title={`incoming · ${incoming.length}`}>
          <EdgeList rows={incoming} arrow="←" />
        </Section>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-hairline px-7 py-5">
      <h3 className="label-meta pb-4">{title}</h3>
      {children}
    </section>
  );
}

function PropRow({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt className="font-mono text-2xs uppercase tracking-widest text-ink-400">{k}</dt>
      <dd className="break-words font-mono text-2xs text-ink-100">
        {v === null ? <span className="text-ink-500">null</span> : String(v)}
      </dd>
    </>
  );
}

function EdgeList({
  rows,
  arrow,
}: {
  rows: Array<{ edge: GraphEdge; other: GraphNode | undefined }>;
  arrow: string;
}) {
  return (
    <ol className="space-y-2">
      {rows.map(({ edge, other }) => (
        <li key={edge.id} className="flex items-baseline gap-3 border-b border-hairline pb-2">
          <span className="font-mono text-2xs uppercase tracking-widest text-accent-500">
            {arrow}
          </span>
          <span className="font-mono text-2xs uppercase tracking-widest text-ink-300">
            {edge.type}
          </span>
          <span className="ml-auto truncate text-2xs text-ink-100" title={other?.label}>
            {other?.label ?? edge.target}
          </span>
        </li>
      ))}
    </ol>
  );
}
