import { useState } from 'react';
import { useGraphSearch } from '../../hooks/useGraphSearch.ts';
import { fmtKindLabel } from '../../lib/format.ts';
import { styleForKind } from '../../lib/kindStyle.ts';

// Left rail of Graph Explorer. Searches across fact / chunk / knowledge /
// procedure / entity fulltext indexes and lets the user pick a root node
// for the canvas. The search input uses the same hairline-bottom field
// pattern as the auth gate so the whole shell feels consistent.

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SearchPanel({ selectedId, onSelect }: Props) {
  const [q, setQ] = useState('');
  const results = useGraphSearch(q, 30);

  return (
    <div className="flex h-full flex-col border-r border-hairline">
      <div className="border-b border-hairline px-6 py-5">
        <span className="label-meta block pb-2">graph · search</span>
        <input
          // biome-ignore lint/a11y/noAutofocus: search is the panel's sole purpose; focus is the expected affordance
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="fact / chunk / entity / procedure"
          className="w-full border-0 border-b border-hairline-strong bg-transparent px-0 pb-2 font-mono text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {q.trim().length === 0 ? (
          <EmptyHint />
        ) : results.isLoading ? (
          <div className="p-6 font-mono text-2xs uppercase tracking-widest text-ink-500">
            searching…
          </div>
        ) : results.data?.results.length === 0 ? (
          <div className="p-6 font-mono text-2xs uppercase tracking-widest text-ink-500">
            no hits
          </div>
        ) : (
          <ol className="py-2">
            {(results.data?.results ?? []).map((r) => {
              const style = styleForKind(r.kind);
              const active = r.id === selectedId;
              return (
                <li key={`${r.kind}:${r.id}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(r.id)}
                    className={`group w-full border-b border-hairline px-6 py-3 text-left transition-colors ${
                      active ? 'bg-accent-500/[0.06]' : 'hover:bg-white/[0.015]'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: style.color }}
                          aria-hidden
                        />
                        <span className="font-mono text-2xs uppercase tracking-widest text-ink-300">
                          {fmtKindLabel(r.kind)}
                        </span>
                      </div>
                      <span className="num text-2xs text-ink-500">{r.score.toFixed(2)}</span>
                    </div>
                    <div className="mt-1.5 truncate text-sm text-ink-100">{r.label}</div>
                    {r.snippet && r.snippet !== r.label && (
                      <div className="mt-1 truncate font-mono text-2xs text-ink-400">
                        {r.snippet}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="p-6">
      <span className="label-meta block pb-3">how to use</span>
      <ol className="space-y-2 text-sm leading-relaxed text-ink-300">
        <li>
          <span className="font-mono text-2xs text-ink-500 mr-2">01</span>
          Search any entity, fact, chunk, or procedure.
        </li>
        <li>
          <span className="font-mono text-2xs text-ink-500 mr-2">02</span>
          Pick a result to load its 1-hop neighborhood.
        </li>
        <li>
          <span className="font-mono text-2xs text-ink-500 mr-2">03</span>
          Click any node to refocus the graph on it.
        </li>
      </ol>
    </div>
  );
}
