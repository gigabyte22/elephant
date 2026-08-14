// CLI entry point for the OKF vault sync. The sync itself lives in
// src/adapters/vault/sync.ts so the scheduler (src/jobs/OkfSyncScheduler.ts)
// can reuse it without src importing from scripts/.
//
// Run: pnpm okf:sync [--dry-run] [--purge] [--no-reap] [--no-index] [--force-reap]
//
//   --dry-run     report what would change without touching a byte
//   --purge       hard-delete everything under _trash/ before syncing
//   --no-reap     skip the disk→graph reconcile entirely
//   --no-index    skip _index.md generation
//   --force-reap  reap even when the graph returned zero nodes (see the guard
//                 in sync.ts — you almost certainly want to check OKF_DIR and
//                 NEO4J_URI first)

import { resolve } from 'node:path';
import { purgeTrash, syncVault } from '../src/adapters/vault/sync.ts';
import { loadEnv } from '../src/config/env.ts';
import { closeDriver } from '../src/config/neo4j.ts';

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const env = loadEnv();
  if (!env.OKF_ENABLED) {
    console.warn('[okf-sync] OKF_ENABLED is false — syncing anyway into', env.OKF_DIR);
  }
  const dryRun = flags.has('--dry-run');

  // Purge first: it clears the tombstones you have already reviewed, and the
  // sweep that follows cannot refill them with the same files.
  if (flags.has('--purge')) {
    if (dryRun) {
      console.log('[okf-sync] --dry-run: skipping --purge');
    } else {
      console.log(`[okf-sync] purged ${await purgeTrash(env.OKF_DIR)} tombstone(s) from _trash/`);
    }
  }

  const stats = await syncVault(env.OKF_DIR, {
    dryRun,
    reap: !flags.has('--no-reap'),
    index: !flags.has('--no-index'),
    forceReap: flags.has('--force-reap'),
  });
  console.log(
    `[okf-sync]${dryRun ? ' (dry run)' : ''} scanned=${stats.scanned} written=${stats.written} ` +
      `skipped=${stats.skipped} tombstoned=${stats.tombstoned} reaped=${stats.reaped} ` +
      `relocated=${stats.relocated} foreign=${stats.foreign} indexes=${stats.indexes} ` +
      `→ ${resolve(env.OKF_DIR)}`,
  );
  if (stats.reapSkipped) {
    console.warn('[okf-sync] the reap was skipped by the empty-graph guard — see the error above');
    process.exitCode = 1;
  }
}

// Only run when executed directly, never as a side effect of an import.
if (process.argv[1]?.endsWith('okf-sync.ts')) {
  main()
    .catch((err) => {
      console.error('[okf-sync] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => closeDriver());
}
