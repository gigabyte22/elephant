// Wipe derived knowledge (Facts + Insights) and reset the dream cursor so the
// next dream cycle re-extracts everything from the RETAINED episodes through
// the current pipeline (prompts, dedup, consolidation). Episodes, Chunks,
// Entities, KnowledgeDocuments, and AuditEvents are kept — this is a rebuild,
// not a data loss.
//
// Run a backup first: python3 scripts/backup-neo4j.py
// Then: pnpm exec tsx scripts/rebuild-facts.ts --yes   (prints counts and
// refuses without --yes). Afterwards trigger a dream: curl -X POST :PORT/dream
// (repeat until backlogEstimate hits 0 — each cycle is episode-capped).

import { loadEnv } from '../src/config/env.ts';
import { closeDriver, read, write } from '../src/config/neo4j.ts';
import { DreamCursorRepository } from '../src/repositories/DreamCursorRepository.ts';

const BATCH = 5000;

async function count(label: string): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(`MATCH (n:${label}) RETURN count(n) AS n`);
    return (r.records[0]?.get('n') as number) ?? 0;
  });
}

async function deleteAll(label: string): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await write(async (tx) => {
      const r = await tx.run(
        `MATCH (n:${label}) WITH n LIMIT ${BATCH} DETACH DELETE n RETURN count(*) AS d`,
      );
      return (r.records[0]?.get('d') as number) ?? 0;
    });
    total += deleted;
    if (deleted === 0) break;
    console.log(`[rebuild-facts] deleted ${label} batch of ${deleted} (total ${total})`);
  }
  return total;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const facts = await count('Fact');
  const insights = await count('Insight');
  const episodes = await count('Episode');
  console.log(
    `[rebuild-facts] ${env.NEO4J_URI} (db=${env.NEO4J_DATABASE}): ${facts} facts + ${insights} insights will be DELETED; ${episodes} episodes retained for re-dreaming.`,
  );

  const confirmed = process.argv.includes('--yes');
  if (!confirmed) {
    console.error('[rebuild-facts] re-run with --yes to confirm. Back up first:');
    console.error('[rebuild-facts]   python3 scripts/backup-neo4j.py');
    process.exit(2);
  }

  await deleteAll('Fact');
  await deleteAll('Insight');

  // Reset the cursor by SETTING it to epoch — deleting the node would make
  // the dreamer fall back to the last completed run's timestamp and skip the
  // whole backlog.
  await write((tx) => DreamCursorRepository.set(tx, new Date(0)));
  console.log('[rebuild-facts] dream cursor reset to epoch.');
  console.log(
    `[rebuild-facts] done. Trigger dreaming to rebuild facts from the ${episodes} retained episodes: curl -X POST http://localhost:${env.MEMORY_PORT}/dream -H "authorization: Bearer $MEMORY_SERVICE_TOKEN"`,
  );
}

main()
  .then(() => closeDriver())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[rebuild-facts] failed:', err);
    await closeDriver().catch(() => undefined);
    process.exit(1);
  });
