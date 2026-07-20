import { Suspense, lazy, useEffect, useState } from 'react';
import type { DocumentItem, DocumentSort, NarrativeKind } from '../api/types.ts';
import { LedgerScroll } from '../components/LedgerScroll.tsx';
import { PageHeading } from '../components/PageHeading.tsx';
import { SegBtnGroup } from '../components/SegButtons.tsx';
import { ErrorBanner, LoadingBanner } from '../components/StateBanner.tsx';
import { useDocuments } from '../hooks/useDocuments.ts';
import { useScope } from '../hooks/useScope.ts';
import { fmtCount, fmtKindLabel, fmtRelativeTime } from '../lib/format.ts';
import { styleForKind } from '../lib/kindStyle.ts';

// The index for the narrative kinds. Research and knowledge documents retain a
// full body on-node but appear nowhere else in the dashboard as first-class
// rows — the graph shows them only as nodes, with the body truncated. Selecting
// a row opens the same markdown projection the OKF vault writes.

// Lazy for the same reason NodeInspector loads it lazily — react-markdown is
// only needed once a row is opened. Both call sites must be dynamic or the
// static one pulls it back into the main bundle.
const MarkdownPanel = lazy(() =>
  import('../components/MarkdownPanel.tsx').then((m) => ({ default: m.MarkdownPanel })),
);

const PAGE_SIZE = 50;
const GRID = 'grid-cols-[2.5rem_9rem_1fr_8rem_6rem_5.5rem]';

const SORTS: ReadonlyArray<DocumentSort> = ['recent', 'created', 'title'];
const SORT_LABEL: Record<DocumentSort, string> = {
  recent: 'updated',
  created: 'created',
  title: 'title',
};

const KINDS = ['all', 'research', 'knowledge_document'] as const;
type KindFilter = (typeof KINDS)[number];

export function Documents() {
  const scope = useScope();
  const [sort, setSort] = useState<DocumentSort>('recent');
  const [kind, setKind] = useState<KindFilter>('all');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<DocumentItem | null>(null);

  // Debounce the box so typing doesn't fire a query per keystroke; every
  // filter change rewinds to the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const docs = useDocuments({
    scope,
    kind: kind === 'all' ? undefined : (kind as NarrativeKind),
    q: q || undefined,
    sort,
    limit: PAGE_SIZE,
    offset,
  });

  const items = docs.data?.items ?? [];
  const total = docs.data?.total ?? 0;

  return (
    <div className="mx-auto max-w-7xl pb-20">
      <PageHeading
        rank={5}
        title="documents"
        right={
          <div className="flex items-center gap-2 border border-hairline-strong">
            <span className="label-meta pl-2.5">sort</span>
            <SegBtnGroup
              value={sort}
              options={SORTS}
              onChange={(s) => {
                setSort(s);
                setOffset(0);
              }}
              render={(s) => SORT_LABEL[s]}
            />
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-end gap-x-8 gap-y-4 border-b border-hairline pb-6">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1.5 md:max-w-sm">
          <span className="label-meta">search</span>
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="search title and summary…"
            className="w-full border-0 border-b border-hairline-strong bg-transparent px-0 pb-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
          />
        </label>
        {/* A div, not a label: SegBtnGroup renders buttons, not a form control. */}
        <div className="flex flex-col gap-1.5">
          <span className="label-meta">kind</span>
          <SegBtnGroup
            value={kind}
            options={KINDS}
            onChange={(k) => {
              setKind(k);
              setOffset(0);
            }}
            render={(k) => (k === 'knowledge_document' ? 'knowledge' : k)}
          />
        </div>
        {docs.data && (
          <span className="label-key ml-auto pb-1">
            {total === 0
              ? 'no matches'
              : `showing ${offset + 1}–${Math.min(offset + items.length, total)} of ${fmtCount(total)}`}
          </span>
        )}
      </div>

      {docs.isError && <ErrorBanner message={(docs.error as Error).message ?? 'failed'} />}
      {docs.isLoading && <LoadingBanner label="reading documents…" />}

      {docs.data && (
        <>
          <LedgerScroll minWidth="52rem">
            <RowHeader />
            <ol>
              {items.map((d, i) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(d)}
                    className={`grid w-full ${GRID} items-baseline gap-5 border-b border-hairline py-3 text-left hover:bg-white/[0.012]`}
                  >
                    <span className="font-mono text-2xs tabular-nums text-ink-500">
                      {String(offset + i + 1).padStart(3, '0')}
                    </span>
                    <span
                      className="truncate font-mono text-2xs uppercase tracking-widest"
                      style={{ color: styleForKind(d.kind).color }}
                    >
                      {fmtKindLabel(d.kind)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink-100">{d.title}</span>
                      {d.summary && (
                        <span className="block truncate text-xs text-ink-400">{d.summary}</span>
                      )}
                    </span>
                    <span className="truncate font-mono text-2xs text-ink-400">
                      {d.projectId ?? '—'}
                    </span>
                    {/* A stub is worth flagging: opening it shows a summary and
                        a "body not retained" note, not a document. */}
                    <span className="font-mono text-2xs uppercase tracking-widest text-ink-500">
                      {d.hasContent ? d.source : 'stub'}
                    </span>
                    <span className="num text-right text-xs text-ink-400">
                      {fmtRelativeTime(sort === 'created' ? d.createdAt : d.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </LedgerScroll>
          {items.length === 0 && (
            <div className="border-b border-hairline py-12 text-center font-mono text-2xs uppercase tracking-widest text-ink-500">
              {q || kind !== 'all'
                ? 'no documents match these filters'
                : 'no documents match the current scope'}
            </div>
          )}

          {total > PAGE_SIZE && (
            <footer className="flex items-center justify-between py-4">
              <PageBtn
                label="‹ prev"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              />
              <span className="label-key">
                page {Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(total / PAGE_SIZE)}
              </span>
              <PageBtn
                label="next ›"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              />
            </footer>
          )}
        </>
      )}

      {selected && (
        <Suspense fallback={null}>
          <MarkdownPanel onClose={() => setSelected(null)} kind={selected.kind} id={selected.id} />
        </Suspense>
      )}
    </div>
  );
}

function PageBtn({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="border border-hairline-strong px-3 py-1 font-mono text-2xs uppercase tracking-widest text-ink-300 transition-colors hover:border-accent-500 hover:text-accent-300 disabled:cursor-not-allowed disabled:border-hairline disabled:text-ink-500"
    >
      {label}
    </button>
  );
}

function RowHeader() {
  return (
    <div className={`grid ${GRID} items-baseline gap-5 border-b border-hairline-strong pb-2`}>
      <span />
      <span className="label-key">kind</span>
      <span className="label-key">title</span>
      <span className="label-key">project</span>
      <span className="label-key">source</span>
      <span className="label-key text-right">updated</span>
    </div>
  );
}
