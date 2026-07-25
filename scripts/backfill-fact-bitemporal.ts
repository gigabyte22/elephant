// Repair bi-temporal clocks on an existing graph after the valid-time / txn-time
// split. Prefer a clean re-extract for dream-derived knowledge when practical:
//   pnpm rebuild:facts -- --yes && (trigger dream until backlog is 0)
//
// This script is the non-destructive alternative:
//   Pass A — Fact.validFrom from linked Episode.timestamp when sourceEpisodeId set
//   Pass B — Fact.validTo on SUPERSEDES targets from max(old.validFrom, new.validFrom)
//            (leaves r.supersededAt untouched — already transaction time)
//   Pass C — Preference.recordedAt = validFrom where recordedAt is missing
//
// Usage:
//   pnpm exec tsx scripts/backfill-fact-bitemporal.ts --dry-run
//   pnpm exec tsx scripts/backfill-fact-bitemporal.ts --yes
//
// Idempotent. Does not change recordedAt on facts (decay/prune must stay sane).

import { loadEnv } from '../src/config/env.ts';
import { closeDriver, read, write } from '../src/config/neo4j.ts';

const BATCH = 500;
const dryRun = process.argv.includes('--dry-run');
const confirmed = process.argv.includes('--yes');

async function count(cypher: string): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(cypher);
    return Number(r.records[0]?.get('n') ?? 0);
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log(`[backfill-bitemporal] ${env.NEO4J_URI} (db=${env.NEO4J_DATABASE}) dryRun=${dryRun}`);

  const needA = await count(
    `MATCH (f:Fact) WHERE f.sourceEpisodeId IS NOT NULL
     MATCH (e:Episode {id: f.sourceEpisodeId})
     WHERE f.validFrom <> e.timestamp
     RETURN count(f) AS n`,
  );
  const needB = await count(
    `MATCH (newF:Fact)-[r:SUPERSEDES]->(oldF:Fact)
     WHERE oldF.validTo IS NOT NULL
       AND oldF.validTo <>
         CASE WHEN newF.validFrom >= oldF.validFrom THEN newF.validFrom ELSE oldF.validFrom END
     RETURN count(r) AS n`,
  );
  const needC = await count('MATCH (p:Preference) WHERE p.recordedAt IS NULL RETURN count(p) AS n');

  console.log(
    `[backfill-bitemporal] candidates: passA(validFrom←episode)=${needA} passB(validTo←event)=${needB} passC(pref.recordedAt)=${needC}`,
  );

  if (!dryRun && !confirmed) {
    console.error(
      '[backfill-bitemporal] re-run with --yes to apply, or --dry-run to preview only.',
    );
    process.exit(2);
  }

  if (dryRun) {
    console.log('[backfill-bitemporal] dry-run complete; no writes.');
    return;
  }

  // Pass A
  let a = 0;
  for (;;) {
    const n = await write(async (tx) => {
      const r = await tx.run(
        `MATCH (f:Fact) WHERE f.sourceEpisodeId IS NOT NULL
         MATCH (e:Episode {id: f.sourceEpisodeId})
         WHERE f.validFrom <> e.timestamp
         WITH f, e LIMIT ${BATCH}
         SET f.validFrom = e.timestamp
         RETURN count(f) AS n`,
      );
      return Number(r.records[0]?.get('n') ?? 0);
    });
    a += n;
    if (n === 0) break;
    console.log(`[backfill-bitemporal] passA batch ${n} (total ${a})`);
  }

  // Pass B — only adjust validTo; leave supersededAt as historical txn time.
  let b = 0;
  for (;;) {
    const n = await write(async (tx) => {
      const r = await tx.run(
        `MATCH (newF:Fact)-[r:SUPERSEDES]->(oldF:Fact)
         WHERE oldF.validTo IS NOT NULL
         WITH oldF, newF,
              CASE WHEN newF.validFrom >= oldF.validFrom
                   THEN newF.validFrom ELSE oldF.validFrom END AS eventEnd
         WHERE oldF.validTo <> eventEnd
         WITH oldF, eventEnd LIMIT ${BATCH}
         SET oldF.validTo = eventEnd
         RETURN count(oldF) AS n`,
      );
      return Number(r.records[0]?.get('n') ?? 0);
    });
    b += n;
    if (n === 0) break;
    console.log(`[backfill-bitemporal] passB batch ${n} (total ${b})`);
  }

  // Pass C
  let c = 0;
  for (;;) {
    const n = await write(async (tx) => {
      const r = await tx.run(
        `MATCH (p:Preference)
         WHERE p.recordedAt IS NULL
         WITH p LIMIT ${BATCH}
         SET p.recordedAt = p.validFrom
         RETURN count(p) AS n`,
      );
      return Number(r.records[0]?.get('n') ?? 0);
    });
    c += n;
    if (n === 0) break;
    console.log(`[backfill-bitemporal] passC batch ${n} (total ${c})`);
  }

  console.log(`[backfill-bitemporal] done: passA=${a} passB=${b} passC=${c}`);
}

main()
  .catch((err) => {
    console.error('[backfill-bitemporal] failed:', err);
    process.exit(1);
  })
  .finally(() => closeDriver());
