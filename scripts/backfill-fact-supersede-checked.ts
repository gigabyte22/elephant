// Stamp facts that were supersede-checked inline, before the check moved to the
// dream cycle.
//
// The sweep introduced alongside INGEST_SUPERSEDE_MODE=dream claims work with
// `WHERE f.supersedeCheckedAt IS NULL` (FactRepository.listPendingSupersedeCheck).
// Every fact written before that change has no such property, so on the first
// boot of the new code the queue is not "the facts nobody checked yet" — it is
// the entire back catalogue of active facts.
//
// Those facts are not unchecked. Under the old behaviour POST /facts ran the
// vector search and the contradiction call *before it returned*, so each one was
// adjudicated exactly once, at write time; the outcome simply was not recorded
// on the node. Stamping them is therefore a repair of missing bookkeeping, not a
// way of skipping work.
//
// Left alone, the sweep would re-judge them at DREAM_SUPERSEDE_SWEEP_MAX_FACTS
// per cycle — days of vector searches and LLM calls inside a dream cycle that is
// already deadline-bound — and would do it against a supersede history that has
// grown since, so a fact written long ago can now be retired by a decision its
// author never asked to revisit.
//
// The cutoff is what keeps this honest: only facts recorded BEFORE the deferred
// path went live were checked inline. Anything written after it genuinely is
// unchecked and must stay in the queue.
//
// Usage:
//   pnpm exec tsx scripts/backfill-fact-supersede-checked.ts                  # dry run
//   pnpm exec tsx scripts/backfill-fact-supersede-checked.ts --yes
//   pnpm exec tsx scripts/backfill-fact-supersede-checked.ts --cutoff=2026-08-10T22:03:40Z --yes
//
// Ordering: run AFTER `pnpm migrate` and after the deploy that introduced the
// sweep — the cutoff must be that deploy's instant. Idempotent: already-stamped
// facts are excluded by the same IS NULL predicate the sweep uses.

import { loadEnv } from '../src/config/env.ts';
import { closeDriver, read, write } from '../src/config/neo4j.ts';

const BATCH = 1000;

// The instant INGEST_SUPERSEDE_MODE=dream began serving on this deployment.
// Override with --cutoff for any other install.
const DEFAULT_CUTOFF = '2026-08-10T22:03:40Z';

const dryRun = !process.argv.includes('--yes');
const cutoff =
  process.argv.find((a) => a.startsWith('--cutoff='))?.slice('--cutoff='.length) ?? DEFAULT_CUTOFF;

// Deliberately the same predicate as FactRepository.listPendingSupersedeCheck,
// so what this stamps is exactly what the sweep would otherwise have claimed.
const CANDIDATES = `
  MATCH (f:Fact)
  WHERE f.supersedeCheckedAt IS NULL
    AND f.deletedAt IS NULL
    AND f.validTo IS NULL
    AND f.recordedAt <= datetime($cutoff)
`;

async function count(cypher: string, params: Record<string, unknown>): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(cypher, params);
    return Number(r.records[0]?.get('n') ?? 0);
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (Number.isNaN(Date.parse(cutoff))) {
    throw new Error(`--cutoff is not a parseable timestamp: ${cutoff}`);
  }

  console.log(
    `[backfill-fact-supersede-checked] ${env.NEO4J_URI} (db=${env.NEO4J_DATABASE}) ` +
      `dryRun=${dryRun} cutoff=${cutoff}`,
  );

  const total = await count(`${CANDIDATES} RETURN count(f) AS n`, { cutoff });
  const after = await count(
    `MATCH (f:Fact)
     WHERE f.supersedeCheckedAt IS NULL AND f.deletedAt IS NULL AND f.validTo IS NULL
       AND f.recordedAt > datetime($cutoff)
     RETURN count(f) AS n`,
    { cutoff },
  );

  console.log(`  checked inline, needs stamping : ${total}`);
  console.log(`  written after cutoff, left for the sweep : ${after}`);

  if (total === 0) {
    console.log('\nNothing to do.');
    return;
  }
  if (dryRun) {
    console.log('\nDry run. Re-run with --yes to apply.');
    return;
  }

  let applied = 0;
  for (;;) {
    const n = await write(async (tx) => {
      const r = await tx.run(
        // toInteger: the driver sends a JS number as a float, which LIMIT rejects.
        `${CANDIDATES}
         WITH f LIMIT toInteger($batch)
         SET f.supersedeCheckedAt = f.recordedAt
         RETURN count(f) AS n`,
        { cutoff, batch: BATCH },
      );
      return Number(r.records[0]?.get('n') ?? 0);
    });
    if (n === 0) break;
    applied += n;
    console.log(`  … ${applied}/${total}`);
  }

  console.log(`\nDone. Stamped ${applied} fact(s); ${after} left for the sweep.`);
}

main()
  .catch((err) => {
    console.error('[backfill-fact-supersede-checked] failed', err);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
