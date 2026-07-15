// Fire-and-forget increment of referenceCount on returned facts — closes
// the loop on the dreaming importance model (importance uses refCount as
// one of its three signals, per SPEC.md §5).
//
// Three modes:
//  - off:    no-op (historical/snapshot queries that shouldn't tick)
//  - async:  schedules a write after state handoff so the response path
//            isn't blocked; errors logged, never thrown (default)
//  - sync:   awaits the write; only useful for deterministic integration
//            tests that assert on the resulting counts

import { write } from '../../../config/neo4j.ts';
import { FactRepository } from '../../../repositories/FactRepository.ts';
import type { RetrievalStage } from '../types.ts';

export function RefCountTickStage(): RetrievalStage {
  return {
    name: 'RefCountTick',
    async run(ctx, state) {
      const mode = ctx.config.refCountTickMode;
      if (mode === 'off' || state.facts.size === 0) return state;

      const ids = Array.from(state.facts.keys());
      const doTick = () =>
        write(async (tx) => {
          await FactRepository.bulkIncrementReferenceCounts(tx, ids);
        });

      if (mode === 'sync') {
        await doTick();
      } else {
        queueMicrotask(() => {
          doTick().catch((err) => {
            // biome-ignore lint/suspicious/noConsole: log-and-continue is deliberate
            console.warn('refcount tick failed', err);
          });
        });
      }
      return state;
    },
  };
}
