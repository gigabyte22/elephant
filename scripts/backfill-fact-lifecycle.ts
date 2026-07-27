// Classify pre-split fact tombstones into deletion vs prune.
//
// Before the lifecycle split, DELETE /facts/:id and the dream prune both wrote
// nothing but `validTo = now`, so the two are indistinguishable on the node.
// This backfill stamps `deletedAt` / `prunedAt` on the rows that predate the
// split, using the audit log — which is authoritative, because both legacy call
// sites already emitted an :AuditEvent ('soft_delete' from
// MemoryIngestionService, 'prune' from DreamingService).
//
// Candidate set = closed-validTo facts with no inbound :SUPERSEDES and which
// are not consolidation merge members. That is the same heuristic
// DashboardRepository.factCounts used, tightened to exclude merges.
//
// Timestamp source is `f.validTo`: on the legacy path both events wrote
// `validTo = now`, i.e. the transaction instant we want.
//
// Rows with NO audit event at all (predating :AuditEvent) default to
// `prunedAt`. That direction is deliberate: `prunedAt` does not gate reads, so
// a misclassification there leaves the row exactly as visible as it is today,
// whereas defaulting to `deletedAt` would retroactively hide history someone
// can currently see. Use --assume-deleted to invert that for graphs known to
// predate auditing where privacy is the priority.
//
// Usage:
//   pnpm exec tsx scripts/backfill-fact-lifecycle.ts --dry-run
//   pnpm exec tsx scripts/backfill-fact-lifecycle.ts --yes [--assume-deleted]
//
// Ordering: run AFTER `pnpm migrate` (it creates no constraint, so there is no
// pre-migrate hazard). Idempotent — already-classified rows are excluded.

import { loadEnv } from '../src/config/env.ts';
import { closeDriver, read, write } from '../src/config/neo4j.ts';

const BATCH = 500;
const dryRun = !process.argv.includes('--yes');
const assumeDeleted = process.argv.includes('--assume-deleted');

// Unclassified tombstones: interval closed, neither lifecycle property set,
// not superseded, not a merge member.
const CANDIDATES = `
  MATCH (f:Fact)
  WHERE f.validTo IS NOT NULL
    AND f.deletedAt IS NULL
    AND f.prunedAt IS NULL
    AND NOT EXISTS { MATCH (:Fact)-[:SUPERSEDES]->(f) }
    AND NOT EXISTS {
      MATCH (s:Fact)
      WHERE s.mergedFromFactIds IS NOT NULL AND f.id IN s.mergedFromFactIds
    }
`;

async function count(cypher: string): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(cypher);
    return Number(r.records[0]?.get('n') ?? 0);
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log(
    `[backfill-fact-lifecycle] ${env.NEO4J_URI} (db=${env.NEO4J_DATABASE}) ` +
      `dryRun=${dryRun} assumeDeleted=${assumeDeleted}`,
  );

  const total = await count(`${CANDIDATES} RETURN count(f) AS n`);
  const deletable = await count(
    `${CANDIDATES}
     AND EXISTS { MATCH (e:AuditEvent) WHERE e.targetId = f.id AND e.kind = 'soft_delete' }
     RETURN count(f) AS n`,
  );
  const prunable = await count(
    `${CANDIDATES}
     AND EXISTS { MATCH (e:AuditEvent) WHERE e.targetId = f.id AND e.kind = 'prune' }
     AND NOT EXISTS { MATCH (e:AuditEvent) WHERE e.targetId = f.id AND e.kind = 'soft_delete' }
     RETURN count(f) AS n`,
  );
  const unattributed = total - deletable - prunable;

  console.log(`  unclassified tombstones : ${total}`);
  console.log(`  → deletedAt (audited)   : ${deletable}`);
  console.log(`  → prunedAt  (audited)   : ${prunable}`);
  console.log(
    `  → no audit event        : ${unattributed} ` +
      `(defaulting to ${assumeDeleted ? 'deletedAt' : 'prunedAt'})`,
  );

  if (dryRun) {
    console.log('\nDry run. Re-run with --yes to apply.');
    return;
  }
  if (total === 0) {
    console.log('\nNothing to do.');
    return;
  }

  let applied = 0;
  for (;;) {
    const n = await write(async (tx) => {
      const r = await tx.run(
        `${CANDIDATES}
         WITH f LIMIT $batch
         OPTIONAL MATCH (d:AuditEvent) WHERE d.targetId = f.id AND d.kind = 'soft_delete'
         WITH f, count(d) AS deleteEvents
         OPTIONAL MATCH (p:AuditEvent) WHERE p.targetId = f.id AND p.kind = 'prune'
         WITH f, deleteEvents, count(p) AS pruneEvents
         WITH f, deleteEvents,
              CASE
                WHEN deleteEvents > 0 THEN true
                WHEN pruneEvents > 0 THEN false
                ELSE $assumeDeleted
              END AS isDelete
         SET f.deletedAt = CASE WHEN isDelete THEN f.validTo ELSE NULL END,
             f.prunedAt  = CASE WHEN isDelete THEN NULL ELSE f.validTo END
         RETURN count(f) AS n`,
        { batch: BATCH, assumeDeleted },
      );
      return Number(r.records[0]?.get('n') ?? 0);
    });
    if (n === 0) break;
    applied += n;
    console.log(`  … ${applied}/${total}`);
  }

  console.log(`\nDone. Classified ${applied} fact(s).`);
}

main()
  .catch((err) => {
    console.error('[backfill-fact-lifecycle] failed', err);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
