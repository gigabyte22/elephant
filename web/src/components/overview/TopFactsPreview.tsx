import { Link } from 'wouter';
import type { TopFact } from '../../api/types.ts';
import { useScope } from '../../hooks/useScope.ts';
import { fmtRelativeTime } from '../../lib/format.ts';
import { scopeToQueryString } from '../../lib/scope.ts';
import { LedgerScroll } from '../LedgerScroll.tsx';
import { RefBar } from '../RefBar.tsx';

// Top-5 most-referenced facts. Ranked, with a tiny strip-chart marker
// representing the refcount (clamped to the row max). Rows are baseline-
// aligned monospace, no avatars, no rounded surfaces. Click any row → /facts
// page (eventually, the row's detail panel).

interface Props {
  items: TopFact[];
}

export function TopFactsPreview({ items }: Props) {
  const scope = useScope();
  const max = items.reduce((m, f) => Math.max(m, f.refCount), 0) || 1;

  return (
    <section
      className="border-b border-hairline py-8 animate-fade-up"
      style={{ animationDelay: '120ms' }}
    >
      <header className="flex items-center justify-between pb-5">
        <span className="label-meta">facts · most referenced</span>
        <Link
          href={`/facts${scopeToQueryString(scope)}`}
          className="font-mono text-2xs uppercase tracking-widest text-ink-300 transition-colors hover:text-accent-300"
        >
          view all →
        </Link>
      </header>
      {items.length === 0 ? (
        <Empty />
      ) : (
        <LedgerScroll minWidth="36rem">
          <ol className="border-t border-hairline">
            {items.map((f, i) => (
              <FactRow key={f.id} rank={i + 1} fact={f} max={max} />
            ))}
          </ol>
        </LedgerScroll>
      )}
    </section>
  );
}

function FactRow({ rank, fact, max }: { rank: number; fact: TopFact; max: number }) {
  const pct = Math.max(2, Math.round((fact.refCount / max) * 100));
  return (
    <li
      className="grid grid-cols-[2rem_5.5rem_1fr_4.5rem_5rem] items-center gap-5 border-b border-hairline px-0 py-3 hover:bg-white/[0.012]"
      title={fact.content}
    >
      <span className="font-mono text-2xs tabular-nums text-ink-500">
        {String(rank).padStart(2, '0')}
      </span>
      <RefBar pct={pct} value={fact.refCount} />
      <span className="truncate text-sm text-ink-100">{fact.content}</span>
      <span className="text-right">
        <span className="label-key block leading-none">importance</span>
        <span className="num text-xs text-ink-300">{fact.importance.toFixed(2)}</span>
      </span>
      <span className="text-right">
        <span className="label-key block leading-none">last hit</span>
        <span className="num text-xs text-ink-300">{fmtRelativeTime(fact.lastReferencedAt)}</span>
      </span>
    </li>
  );
}

function Empty() {
  return (
    <div className="border-t border-hairline py-12 text-center font-mono text-2xs uppercase tracking-widest text-ink-500">
      no fact references recorded yet
    </div>
  );
}
