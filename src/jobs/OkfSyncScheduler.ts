import { Cron } from 'croner';
import { syncVault } from '../adapters/vault/sync.ts';
import type { Container } from '../index.ts';
import type { SchedulerHandle } from './DreamScheduler.ts';

// Scheduled OKF vault sweep. Projection is log-and-continue, and research
// expiry is enforced on read with no graph-side reaper, so without this the
// vault only reconciles when someone remembers to run `pnpm okf:sync` — and a
// lapsed record keeps its live vault file indefinitely.
//
// `protect: true` skips a tick whose predecessor is still running, but there
// is no cross-process lock — a manual `pnpm okf:sync` can still race a tick.
// The writer's temp-sibling + rename keeps that from tearing a file.
//
// This is the only caller that sweeps a *live* vault, which is what the reap's
// mtime gate in sync.ts exists for. Purging is never scheduled: the hard delete
// stays manual (`pnpm okf:sync --purge`).
export function startOkfSyncScheduler(container: Container): SchedulerHandle {
  const pattern = container.env.OKF_SYNC_CRON;
  const job = new Cron(pattern, { protect: true }, async () => {
    try {
      const stats = await syncVault(container.env.OKF_DIR);
      if (stats.written > 0 || stats.tombstoned > 0 || stats.reaped > 0 || stats.relocated > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[okf-sync] scanned=${stats.scanned} written=${stats.written} ` +
            `skipped=${stats.skipped} tombstoned=${stats.tombstoned} ` +
            `reaped=${stats.reaped} relocated=${stats.relocated} indexes=${stats.indexes}`,
        );
      }
      if (stats.reapSkipped) {
        // eslint-disable-next-line no-console
        console.warn('[okf-sync] reap skipped by the empty-graph guard — check OKF_DIR/NEO4J_URI');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[okf-sync] failed', err);
    }
  });
  return {
    pattern,
    stop: () => job.stop(),
  };
}
