import { useEffect, useState } from 'react';
import { apiGet } from '../api/client.ts';
import type { AuditEvent, AuditEventKind, AuditPayload } from '../api/types.ts';
import { LedgerScroll } from '../components/LedgerScroll.tsx';
import { PageHeading } from '../components/PageHeading.tsx';
import { ControlGroup, SegBtnGroup } from '../components/SegButtons.tsx';
import { ErrorBanner, LoadingBanner } from '../components/StateBanner.tsx';
import { useAudit } from '../hooks/useAudit.ts';
import { fmtKindLabel, fmtRelativeTime } from '../lib/format.ts';

// Audit — append-only event feed. Each event is one mutation. Kind is shown
// as a tiny color-coded chip on the left edge and is filterable; the actor
// rides in its own column. Clicking a row expands the full pretty-printed
// payload, and "load older" pages backwards through history with a
// before-cursor on the event timestamp.

const KIND_COLOR: Record<string, string> = {
  create: 'bg-sage',
  update: 'bg-accent-500',
  supersede: 'bg-accent-300',
  soft_delete: 'bg-rust',
  prune: 'bg-rust',
  promote: 'bg-sage',
  archive: 'bg-ink-300',
  merge: 'bg-cyan-500',
};

const KIND_FILTERS = [
  'all',
  'create',
  'update',
  'supersede',
  'soft_delete',
  'prune',
  'promote',
  'archive',
  'merge',
] as const;

const PAGE_SIZE = 100;
const GRID = 'grid-cols-[1.5rem_5.5rem_7rem_9rem_1fr_6rem_5rem]';

export function Audit() {
  const [actor, setActor] = useState('');
  const [kindFilter, setKindFilter] = useState<(typeof KIND_FILTERS)[number]>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [older, setOlder] = useState<AuditEvent[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const actorParam = actor.trim() || undefined;
  const kindParam = kindFilter === 'all' ? undefined : (kindFilter as AuditEventKind);

  const audit = useAudit({ actor: actorParam, kind: kindParam, limit: PAGE_SIZE });

  // Any filter change invalidates the accumulated backlog.
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters are the trigger
  useEffect(() => {
    setOlder([]);
    setExhausted(false);
    setExpanded(null);
  }, [actorParam, kindParam]);

  const head = audit.data?.items ?? [];
  const seen = new Set(head.map((e) => e.id));
  const items = [...head, ...older.filter((e) => !seen.has(e.id))];

  async function loadOlder() {
    const last = items[items.length - 1];
    if (!last || loadingOlder) return;
    setLoadingOlder(true);
    try {
      // `to` is inclusive server-side; step 1ms back and de-dup by id anyway.
      const cursor = new Date(new Date(last.at).getTime() - 1).toISOString();
      const page = await apiGet<AuditPayload>('/audit', {
        search: { actor: actorParam, kind: kindParam, to: cursor, limit: PAGE_SIZE },
      });
      const known = new Set(items.map((e) => e.id));
      const fresh = page.items.filter((e) => !known.has(e.id));
      if (fresh.length > 0) setOlder((prev) => [...prev, ...fresh]);
      if (page.items.length < PAGE_SIZE || fresh.length === 0) setExhausted(true);
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl pb-20">
      <PageHeading
        rank={8}
        title="audit"
        right={
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <label className="flex items-baseline gap-3">
              <span className="label-meta">filter · actor</span>
              <input
                value={actor}
                onChange={(e) => setActor(e.target.value)}
                placeholder="any"
                className="w-40 border-0 border-b border-hairline-strong bg-transparent px-0 pb-0.5 font-mono text-2xs text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
              />
            </label>
            <span className="label-key">{items.length} events</span>
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap gap-x-6 gap-y-4 border-b border-hairline pb-6">
        <ControlGroup label="kind">
          <SegBtnGroup
            value={kindFilter}
            options={KIND_FILTERS}
            onChange={setKindFilter}
            render={(k) => k.replace('_', ' ')}
          />
        </ControlGroup>
      </div>

      {audit.isError && <ErrorBanner message={(audit.error as Error).message} />}
      {audit.isLoading && <LoadingBanner label="reading audit ledger…" />}

      {audit.data && (
        <>
          <LedgerScroll minWidth="46rem">
            <RowHeader />
            {items.length === 0 ? (
              <div className="border-b border-hairline py-12 text-center font-mono text-2xs uppercase tracking-widest text-ink-500">
                no audit events match
              </div>
            ) : (
              <ol>
                {items.map((e) => (
                  <Row
                    key={e.id}
                    event={e}
                    expanded={expanded === e.id}
                    onToggle={() => setExpanded(expanded === e.id ? null : e.id)}
                  />
                ))}
              </ol>
            )}
          </LedgerScroll>

          {items.length > 0 && !exhausted && (
            <footer className="flex justify-center py-4">
              <button
                type="button"
                onClick={loadOlder}
                disabled={loadingOlder}
                className="border border-hairline-strong px-4 py-1.5 font-mono text-2xs uppercase tracking-widest text-ink-300 transition-colors hover:border-accent-500 hover:text-accent-300 disabled:cursor-wait disabled:text-ink-500"
              >
                {loadingOlder ? 'reading…' : 'load older →'}
              </button>
            </footer>
          )}
        </>
      )}
    </div>
  );
}

function RowHeader() {
  return (
    <div className={`grid ${GRID} gap-5 border-y border-hairline py-2`}>
      <span className="label-key">·</span>
      <span className="label-key">kind</span>
      <span className="label-key">target</span>
      <span className="label-key">target id</span>
      <span className="label-key">payload</span>
      <span className="label-key">actor</span>
      <span className="label-key text-right">at</span>
    </div>
  );
}

function Row({
  event,
  expanded,
  onToggle,
}: {
  event: AuditEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="border-b border-hairline">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`grid w-full ${GRID} items-baseline gap-5 py-3 text-left hover:bg-white/[0.012]`}
      >
        <span className="flex h-full items-center">
          <span
            className={`h-2 w-2 rounded-full ${KIND_COLOR[event.kind] ?? 'bg-ink-400'}`}
            aria-hidden
          />
        </span>
        <span className="font-mono text-2xs uppercase tracking-widest text-ink-100">
          {event.kind}
        </span>
        <span className="font-mono text-2xs uppercase tracking-widest text-ink-300">
          {fmtKindLabel(event.targetKind)}
        </span>
        <span className="truncate font-mono text-2xs text-ink-400">{event.targetId}</span>
        <span className="truncate font-mono text-2xs text-ink-300">
          {payloadSnippet(event.payload)}
        </span>
        <span className="truncate font-mono text-2xs text-ink-400">{event.actor ?? '—'}</span>
        <span className="num text-right text-2xs text-ink-400">{fmtRelativeTime(event.at)}</span>
      </button>
      {expanded && (
        <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-accent-500/40 bg-white/[0.01] p-4 font-mono text-2xs leading-relaxed text-ink-300">
          {payloadPretty(event.payload)}
        </pre>
      )}
    </li>
  );
}

function payloadSnippet(payload: unknown): string {
  if (payload === null || payload === undefined) return '—';
  if (typeof payload === 'string') return payload;
  try {
    const json = JSON.stringify(payload);
    return json.length > 200 ? `${json.slice(0, 199)}…` : json;
  } catch {
    return '[unserialisable]';
  }
}

function payloadPretty(payload: unknown): string {
  if (payload === null || payload === undefined) return '—';
  try {
    // Payloads often arrive as JSON-encoded strings; unwrap before printing.
    const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return JSON.stringify(value, null, 2);
  } catch {
    return typeof payload === 'string' ? payload : '[unserialisable]';
  }
}
