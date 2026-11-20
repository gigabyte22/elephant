// Wipe all graph data, keep schema. Refuses to run unless --yes is passed, in
// every environment: NODE_ENV says nothing about which database .env points at.

import { loadEnv } from '../src/config/env.ts';
import { closeDriver, write } from '../src/config/neo4j.ts';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!process.argv.includes('--yes')) {
    console.error(
      `[wipe] this will DELETE ALL DATA in ${env.NEO4J_URI} (db=${env.NEO4J_DATABASE}).`,
    );
    console.error('[wipe] re-run with --yes to confirm.');
    process.exit(2);
  }

  // Batch deletion to keep tx size bounded.
  let totalDeleted = 0;
  for (;;) {
    const deleted = await write(async (tx) => {
      const result = await tx.run(
        'MATCH (n) WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS d',
      );
      return (result.records[0]?.get('d') as number) ?? 0;
    });
    totalDeleted += deleted;
    if (deleted === 0) break;
    console.log(`[wipe] deleted batch of ${deleted} (running total: ${totalDeleted})`);
  }
  console.log(`[wipe] done. removed ${totalDeleted} nodes total. schema preserved.`);
}

main()
  .then(() => closeDriver())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[wipe] failed:', err);
    await closeDriver().catch(() => undefined);
    process.exit(1);
  });
