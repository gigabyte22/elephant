// CLI entry point for the OKF vault sync. The sync itself lives in
// src/adapters/vault/sync.ts so the scheduler (src/jobs/OkfSyncScheduler.ts)
// can reuse it without src importing from scripts/.
//
// Run: pnpm okf:sync

import { resolve } from 'node:path';
import { syncVault } from '../src/adapters/vault/sync.ts';
import { loadEnv } from '../src/config/env.ts';
import { closeDriver } from '../src/config/neo4j.ts';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.OKF_ENABLED) {
    console.warn('[okf-sync] OKF_ENABLED is false — syncing anyway into', env.OKF_DIR);
  }
  const stats = await syncVault(env.OKF_DIR);
  console.log(
    `[okf-sync] scanned=${stats.scanned} written=${stats.written} skipped=${stats.skipped} tombstoned=${stats.tombstoned} → ${resolve(env.OKF_DIR)}`,
  );
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
