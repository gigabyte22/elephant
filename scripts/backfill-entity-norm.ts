// One-shot backfill for the case/whitespace-folded entity identity (`nameNorm`).
//
// Pre-existing graphs merged entities on the exact `name`, so "Alice", "alice",
// and "Alice " are separate nodes. The new `entity_name_norm` uniqueness
// constraint would fail to create while those duplicates exist. This script:
//   1. stamps `nameNorm = toLower(trim(name))` on every entity, and
//   2. collapses each duplicate group onto a survivor (the one with the most
//      HAS_FACT edges), redirecting relationships and deleting the losers.
//
// Run it ONCE before `npm run migrate` on any database that predates the
// nameNorm constraint:  tsx scripts/backfill-entity-norm.ts
//
// It is idempotent — a second run finds no duplicates and no-ops.

import { closeDriver, read, verifyConnectivity, write } from '../src/config/neo4j.ts';

interface DupeGroup {
  norm: string;
  members: Array<{ id: string; deg: number }>;
}

async function run(): Promise<void> {
  await verifyConnectivity();

  // 1. Stamp nameNorm everywhere (cheap, idempotent).
  await write(async (tx) => {
    await tx.run('MATCH (e:Entity) SET e.nameNorm = toLower(trim(e.name))');
  });
  console.log('[backfill] nameNorm stamped on all entities');

  // 2. Find duplicate groups, carrying each member's HAS_FACT degree so we can
  //    keep the best-connected node as the survivor.
  const groups = await read(async (tx) => {
    const result = await tx.run(
      `MATCH (e:Entity)
       OPTIONAL MATCH (e)-[r:HAS_FACT]->()
       WITH e, count(r) AS deg
       WITH e.nameNorm AS norm, collect({ id: e.id, deg: deg }) AS members
       WHERE size(members) > 1
       RETURN norm, members`,
    );
    return result.records.map((rec) => ({
      norm: rec.get('norm') as string,
      members: (rec.get('members') as Array<{ id: string; deg: unknown }>).map((m) => ({
        id: m.id,
        deg: Number(m.deg),
      })),
    })) as DupeGroup[];
  });

  if (groups.length === 0) {
    console.log('[backfill] no duplicate entities — nothing to merge');
    return;
  }

  let merged = 0;
  for (const group of groups) {
    const sorted = [...group.members].sort((a, b) => b.deg - a.deg);
    const survivor = sorted[0]!;
    const loserIds = sorted.slice(1).map((m) => m.id);

    await write(async (tx) => {
      await tx.run(
        `MATCH (survivor:Entity {id: $survivorId})
         UNWIND $loserIds AS lid
         MATCH (loser:Entity {id: lid})
         OPTIONAL MATCH (loser)-[:HAS_FACT]->(f)
         WITH survivor, loser, collect(f) AS facts
         FOREACH (f IN facts | MERGE (survivor)-[:HAS_FACT]->(f))
         DETACH DELETE loser`,
        { survivorId: survivor.id, loserIds },
      );
    });
    merged += loserIds.length;
    console.log(
      `[backfill] "${group.norm}": kept ${survivor.id} (deg ${survivor.deg}), merged ${loserIds.length} duplicate(s)`,
    );
  }

  console.log(`[backfill] done — collapsed ${merged} duplicate entit${merged === 1 ? 'y' : 'ies'}`);
}

run()
  .then(() => closeDriver())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[backfill] failed:', err);
    await closeDriver().catch(() => undefined);
    process.exit(1);
  });
