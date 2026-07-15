import { useEffect, useState } from 'react';
import type { FactSort, TopFact } from '../api/types.ts';
import { LedgerScroll } from '../components/LedgerScroll.tsx';
import { PageHeading } from '../components/PageHeading.tsx';
import { RefBar } from '../components/RefBar.tsx';
import { SegBtnGroup } from '../components/SegButtons.tsx';
import { ErrorBanner, LoadingBanner } from '../components/StateBanner.tsx';
import { FactDetailPanel } from '../components/facts/FactDetailPanel.tsx';
import { useFactCategories } from '../hooks/useFactCategories.ts';
import { useScope } from '../hooks/useScope.ts';
import { useTopFacts } from '../hooks/useTopFacts.ts';
import { fmtCount, fmtRelativeTime } from '../lib/format.ts';

// Facts ledger — sortable by refs / importance / recent, text-searchable,
// category-filterable, paginated. Rows are baseline-aligned monospace with
// hairline separators; clicking a row opens the full detail slide-over with
// entities and supersede lineage.

const SORTS: ReadonlyArray<FactSort> = ['refs', 'importance', 'recent'];
const SORT_LABEL: Record<FactSort, string> = {
  refs: 'by references',
  importance: 'by importance',
  recent: 'by recency',
};

const PAGE_SIZE = 50;
const GRID = 'grid-cols-[2.5rem_5.5rem_1fr_4rem_4rem_4rem_5.5rem]';

export function Facts() {
  const scope = useScope();
  const [sort, setSort] = useState<FactSort>('refs');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<TopFact | null>(null);

  // Debounce the search box into the query param; every filter change
  // rewinds to the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const facts = useTopFacts({
    scope,
    sort,
    limit: PAGE_SIZE,
    offset,
    q: q || undefined,
    category: category || undefined,
  });
  const categories = useFactCategories(scope);

  const items = facts.data?.items ?? [];
  const total = facts.data?.total ?? 0;
  const max = items.reduce((m, f) => Math.max(m, f.refCount), 0) || 1;

  return (
    <div className="mx-auto max-w-7xl pb-20">
      <PageHeading
        rank={3}
        title="facts"
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
            placeholder="search fact content…"
            className="w-full border-0 border-b border-hairline-strong bg-transparent px-0 pb-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label-meta">category</span>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setOffset(0);
            }}
            className="border border-hairline-strong bg-transparent px-3 py-1 font-mono text-2xs uppercase tracking-widest text-ink-100 focus:border-accent-500 focus:outline-none"
          >
            <option value="" className="bg-ink-900">
              all
            </option>
            {(categories.data?.items ?? []).map((c) => (
              <option key={c.category} value={c.category} className="bg-ink-900">
                {c.category} · {c.count}
              </option>
            ))}
          </select>
        </label>
        {facts.data && (
          <span className="label-key ml-auto pb-1">
            {total === 0
              ? 'no matches'
              : `showing ${offset + 1}–${Math.min(offset + items.length, total)} of ${fmtCount(total)}`}
          </span>
        )}
      </div>

      {facts.isError && <ErrorBanner message={(facts.error as Error).message ?? 'failed'} />}
      {facts.isLoading && <LoadingBanner label="reading fact ledger…" />}

      {facts.data && (
        <>
          <LedgerScroll minWidth="48rem">
            <RowHeader />
            <ol>
              {items.map((f, i) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(f)}
                    className={`grid w-full ${GRID} items-baseline gap-5 border-b border-hairline py-3 text-left hover:bg-white/[0.012]`}
                  >
                    <span className="font-mono text-2xs tabular-nums text-ink-500">
                      {String(offset + i + 1).padStart(3, '0')}
                    </span>
                    <RefBar
                      pct={Math.max(2, Math.round((f.refCount / max) * 100))}
                      value={f.refCount}
                    />
                    <span className="truncate text-sm text-ink-100">{f.content}</span>
                    <span className="num text-right text-xs text-ink-300">
                      {f.importance.toFixed(2)}
                    </span>
                    <span className="num text-right text-xs text-ink-300">
                      {f.confidence.toFixed(2)}
                    </span>
                    <span className={`num text-right text-xs ${retentionTone(f)}`}>
                      {f.retention.toFixed(2)}
                    </span>
                    <span className="num text-right text-xs text-ink-400">
                      {fmtRelativeTime(f.lastReferencedAt ?? f.recordedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </LedgerScroll>
          {items.length === 0 && (
            <div className="border-b border-hairline py-12 text-center font-mono text-2xs uppercase tracking-widest text-ink-500">
              {q || category ? 'no facts match these filters' : 'no facts match the current scope'}
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

      <FactDetailPanel fact={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function retentionTone(f: TopFact): string {
  if (f.importance >= 0.75) return 'text-cyan-400';
  if (f.retention < 0.2) return 'text-rust';
  return 'text-ink-300';
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
    <div className={`grid ${GRID} gap-5 border-y border-hairline py-2`}>
      <span className="label-key">#</span>
      <span className="label-key">refs</span>
      <span className="label-key">content</span>
      <span className="label-key text-right">imp</span>
      <span className="label-key text-right">conf</span>
      <span className="label-key text-right">ret</span>
      <span className="label-key text-right">last</span>
    </div>
  );
}
