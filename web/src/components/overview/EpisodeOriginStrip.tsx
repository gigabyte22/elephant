import type { EpisodeOriginsPayload } from '../../api/types.ts';
import { fmtCount, fmtPercent } from '../../lib/format.ts';

// Provenance strip — where episodes come from (user chat, cron dreams,
// events, system, content ingest). Same hairline-cell vocabulary as
// StatStrip, one cell per origin, ordered by volume.

interface Props {
  payload: EpisodeOriginsPayload;
}

export function EpisodeOriginStrip({ payload }: Props) {
  const items = payload.items;
  if (items.length === 0) return null;
  const total = items.reduce((a, b) => a + b.count, 0);

  return (
    <section
      className="animate-fade-up border-b border-hairline"
      style={{ animationDelay: '80ms' }}
    >
      <header className="pt-6">
        <span className="label-meta">episodes · by origin</span>
      </header>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5">
        {items.map((item, i) => (
          <div
            key={item.origin}
            className={`flex flex-col gap-1 py-5 pl-6 pr-5 ${
              i === 0 ? 'pl-0' : 'border-l border-hairline'
            }`}
          >
            <span className="label-key">{item.origin}</span>
            <span className="num text-2xl font-light tracking-tight text-ink-100">
              {fmtCount(item.count)}
            </span>
            <span className="font-mono text-2xs text-ink-400">{fmtPercent(item.count, total)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
