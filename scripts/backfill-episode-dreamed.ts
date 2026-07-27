// Migrate the dream cursor onto per-episode markers.
//
// The old cycle tracked progress with a single :SystemState {key:"dream.cursor"}
// holding the CLIENT-supplied timestamp of the last processed episode. That is
// replaced by e.dreamedAt / e.dreamAttempts / e.dreamNextAttemptAt.
//
// Two passes:
//
//   A. Stamp recordedAt on episodes that predate the field. There is no record
//      of the true write time, so `timestamp` is the best available estimate.
//      It only affects work-queue ORDER BY, never bi-temporal correctness.
//
//   B. Mark everything at or below the old cursor as dreamed, using the cursor
//      value as the timestamp — those episodes really were processed.
//
// Then report the population the old design silently lost: episodes BELOW the
// cursor that were never processed, because they were POSTed with a backdated
// timestamp and the strictly-greater-than selector could never see them again.
// Those are deliberately left unmarked, so the next cycle picks them up.
//
// Usage:
//   pnpm exec tsx scripts/backfill-episode-dreamed.ts --dry-run
//   pnpm exec tsx scripts/backfill-episode-dreamed.ts --yes
//
// Ordering: run AFTER `pnpm migrate`. Idempotent — already-marked episodes are
// excluded, so a re-run is a no-op. The :SystemState cursor node is left in
// place for one release so a rollback is not destructive.

import { loadEnv } from '../src/config/env.ts';
import { closeDriver, read, write } from '../src/config/neo4j.ts';

const BATCH = 500;
const dryRun = !process.argv.includes('--yes');

async function scalar(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(cypher, params);
    return Number(r.records[0]?.get('n') ?? 0);
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log(
    `[backfill-episode-dreamed] ${env.NEO4J_URI} (db=${env.NEO4J_DATABASE}) dryRun=${dryRun}`,
  );

  const cursor = await read(async (tx) => {
    const r = await tx.run(`MATCH (s:SystemState {key: 'dream.cursor'}) RETURN s.cursor AS cursor`);
    return r.records[0]?.get('cursor') ?? null;
  });

  if (cursor === null) {
    console.log('  no dream cursor found — nothing was ever dreamed, or already migrated.');
  }

  const missingRecordedAt = await scalar(
    'MATCH (e:Episode) WHERE e.recordedAt IS NULL RETURN count(e) AS n',
  );
  const toMark =
    cursor === null
      ? 0
      : await scalar(
          `MATCH (e:Episode)
           WHERE e.dreamedAt IS NULL AND e.timestamp <= $cursor
           RETURN count(e) AS n`,
          { cursor },
        );
  // Episodes below the cursor with no derived facts: the ones a backdated POST
  // made permanently invisible to the old selector.
  const strandedBelowCursor =
    cursor === null
      ? 0
      : await scalar(
          `MATCH (e:Episode)
           WHERE e.dreamedAt IS NULL AND e.timestamp <= $cursor
             AND NOT EXISTS { MATCH (e)-[:CONTAINS]->(:Fact) }
           RETURN count(e) AS n`,
          { cursor },
        );

  console.log(`  episodes missing recordedAt      : ${missingRecordedAt}`);
  console.log(`  episodes to mark dreamed         : ${toMark}`);
  console.log(`    …of which produced no facts    : ${strandedBelowCursor}`);
  console.log(
    '    (those are likely the backdated episodes the cursor could never reach;\n' +
      '     they are marked dreamed here only if they DID produce facts — see below)',
  );

  if (dryRun) {
    console.log('\nDry run. Re-run with --yes to apply.');
    return;
  }

  // Pass A — recordedAt from event time.
  let stampedTotal = 0;
  for (;;) {
    const n = await write(async (tx) => {
      const r = await tx.run(
        `MATCH (e:Episode) WHERE e.recordedAt IS NULL
         WITH e LIMIT $batch
         SET e.recordedAt = e.timestamp
         RETURN count(e) AS n`,
        { batch: BATCH },
      );
      return Number(r.records[0]?.get('n') ?? 0);
    });
    if (n === 0) break;
    stampedTotal += n;
    console.log(`  recordedAt … ${stampedTotal}/${missingRecordedAt}`);
  }

  // Pass B — mark as dreamed only those at/below the cursor that actually
  // produced facts. An episode below the cursor with NO derived facts is far
  // more likely to be one the backdating bug skipped than one that genuinely
  // yielded nothing, and leaving it unmarked simply means the next cycle tries
  // it — cheap, and recovers real data. The cost of guessing wrong is one
  // redundant extraction whose output dedup will drop.
  let markedTotal = 0;
  if (cursor !== null) {
    for (;;) {
      const n = await write(async (tx) => {
        const r = await tx.run(
          `MATCH (e:Episode)
           WHERE e.dreamedAt IS NULL AND e.timestamp <= $cursor
             AND EXISTS { MATCH (e)-[:CONTAINS]->(:Fact) }
           WITH e LIMIT $batch
           SET e.dreamedAt = $cursor
           RETURN count(e) AS n`,
          { cursor, batch: BATCH },
        );
        return Number(r.records[0]?.get('n') ?? 0);
      });
      if (n === 0) break;
      markedTotal += n;
      console.log(`  dreamed … ${markedTotal}`);
    }
  }

  const pending = await scalar('MATCH (e:Episode) WHERE e.dreamedAt IS NULL RETURN count(e) AS n');
  console.log(
    `\nDone. recordedAt stamped: ${stampedTotal}, marked dreamed: ${markedTotal}.\n` +
      `${pending} episode(s) now pending — run \`pnpm dream\` until the backlog drains.`,
  );
}

main()
  .catch((err) => {
    console.error('[backfill-episode-dreamed] failed', err);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
