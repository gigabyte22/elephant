// Retire user-axis values that no longer name anybody.
//
// An orchestrator's idea of "who is this" changes over an install's life. Rows
// written before it had accounts carry whatever string was in that slot at the
// time — a pre-auth 'web-user', a 'system' for scheduled work, a bare agent
// name, an email address. None of those will ever be written again, or ever
// match a caller. They stay readable wherever the user axis is off, but they
// are stranded for the dream cycle: dedup, supersede and consolidation all
// bucket by (projectId, userId), so each dead value is its own lane that
// nothing can merge into. Clearing the axis collapses them into their project's
// shared lane, where consolidation can drain them over later cycles.
//
// Usage:
//   pnpm exec tsx scripts/backfill-retire-legacy-user-ids.ts --retire=web-user,system --dry-run
//   pnpm exec tsx scripts/backfill-retire-legacy-user-ids.ts --retire=web-user,system --yes
//   pnpm exec tsx scripts/backfill-retire-legacy-user-ids.ts --undo --yes
//
// Run the dry run first: it prints every distinct user-axis value in the graph
// with its row count, which is the list you pick --retire= from. The values are
// named explicitly rather than matched by pattern, because what counts as a
// real account id is the orchestrator's convention, not this service's.
//
// Reversible by construction: each row's old value is stamped on `legacyUserId`
// before the axis is cleared, and `--undo` puts it back — every stamp in the
// graph, not just the last run's. Only this script's own write rewinds, though:
// once a dream cycle has merged the collapsed lanes, --undo restores the axis,
// not the pre-merge rows. Idempotent: a row that is already retired has no
// `userId` left to match.
//
// Scope: `:MemoryItem`, which is every scope-filtered kind — facts, episodes,
// chunks, research, knowledge, insights. NOT :WorkingState, which is keyed by
// (agentId, sessionId, userId, projectId): clearing an axis there does not
// re-file a row, it renames the key out from under whatever wrote it.
//
// Rows with no projectId are skipped unless --include-unscoped is passed. NULL
// on both axes means "readable by everyone", so clearing the user axis on one
// of those does not re-file it, it publishes it.

import { loadEnv } from '../src/config/env.ts';
import { closeDriver, read, write } from '../src/config/neo4j.ts';

const LOG = '[backfill-retire-user-ids]';
const BATCH = 500;

const dryRun = process.argv.includes('--dry-run');
const confirmed = process.argv.includes('--yes');
const undo = process.argv.includes('--undo');
const includeUnscoped = process.argv.includes('--include-unscoped');

const retire = (process.argv.find((a) => a.startsWith('--retire=')) ?? '')
  .slice('--retire='.length)
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

/** Present as its own clause so the skip is visible in the counts, not implied. */
const scopedOnly = includeUnscoped ? '' : ' AND n.projectId IS NOT NULL';

// Each set is written once and shared by its count and its write, so the two
// cannot drift. `legacyUserId IS NULL` is what stops a stamp being overwritten:
// retiring a row that was retired and then written to again would replace the
// original value with the newer one, and --undo would restore the wrong thing.
const retirableMatch = `MATCH (n:MemoryItem)
     WHERE n.userId IN $retire AND n.legacyUserId IS NULL${scopedOnly}`;
// `userId IS NULL` is the mirror of the guard above, and it matters more.
// Every repository write sets `n.userId` unconditionally, so a row retired on
// Monday and written to on Tuesday carries a REAL account id and a dead stamp.
// Restoring the stamp over it would put the dead value back and leave the real
// one nowhere in the graph — a data-loss path inside the safety net. The live
// value wins; a re-written row keeps its stamp instead of being restored.
const undoableMatch = `MATCH (n:MemoryItem)
     WHERE n.legacyUserId IS NOT NULL AND n.userId IS NULL`;

async function count(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(cypher, params);
    return Number(r.records[0]?.get('n') ?? 0);
  });
}

/** Prints every distinct user-axis value with its row count — the --retire= menu. */
async function survey(): Promise<void> {
  const rows = await read(async (tx) => {
    const r = await tx.run(
      `MATCH (n:MemoryItem) WHERE n.userId IS NOT NULL
       RETURN n.userId AS userId,
              count(*) AS total,
              count(CASE WHEN n.projectId IS NULL THEN 1 END) AS unscoped
       ORDER BY total DESC`,
    );
    return r.records.map((rec) => ({
      userId: rec.get('userId') as string,
      total: Number(rec.get('total')),
      unscoped: Number(rec.get('unscoped')),
    }));
  });
  console.log(`${LOG} user-axis values currently in the graph:`);
  for (const row of rows) {
    const note = row.unscoped > 0 ? `  (${row.unscoped} with no projectId)` : '';
    console.log(`${LOG}   ${row.userId} — ${row.total}${note}`);
  }
}

/**
 * Both flows report what they would do and then stop unless the operator has
 * committed. Returns true when the run should end here without writing.
 */
function stopBeforeWriting(): boolean {
  if (dryRun) {
    console.log(`${LOG} dry-run complete; no writes.`);
    return true;
  }
  if (!confirmed) {
    console.error(`${LOG} re-run with --yes to apply, or --dry-run to preview only.`);
    process.exit(2);
  }
  return false;
}

/**
 * Runs `cypher` in batches until it reports nothing left to do. Each batch's
 * write takes its own rows out of the match, which is what terminates the loop.
 */
async function drain(
  label: string,
  cypher: string,
  params: Record<string, unknown>,
): Promise<void> {
  let done = 0;
  for (;;) {
    const n = await write(async (tx) => {
      const r = await tx.run(cypher, { ...params, batch: BATCH });
      return Number(r.records[0]?.get('n') ?? 0);
    });
    done += n;
    if (n === 0) break;
    console.log(`${LOG} ${label} batch ${n} (total ${done})`);
  }
  console.log(`${LOG} ${label} complete: ${done}`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log(`${LOG} ${env.NEO4J_URI} (db=${env.NEO4J_DATABASE}) dryRun=${dryRun} undo=${undo}`);

  if (undo) {
    const undoable = await count(`${undoableMatch} RETURN count(n) AS n`);
    console.log(`${LOG} rows carrying a stamped legacyUserId: ${undoable}`);
    if (stopBeforeWriting()) return;
    await drain(
      'undo',
      `${undoableMatch}
       WITH n LIMIT toInteger($batch)
       SET n.userId = n.legacyUserId
       SET n.legacyUserId = NULL
       RETURN count(n) AS n`,
      {},
    );
    return;
  }

  await survey();

  if (retire.length === 0) {
    console.error(`${LOG} nothing to do — pass --retire=<value>[,<value>…] naming values above.`);
    process.exit(2);
  }

  const retirable = await count(`${retirableMatch} RETURN count(n) AS n`, { retire });
  // Rows matching --retire that are already stamped are excluded by design, but
  // silently: the operator would watch a count that never reaches zero while
  // survey() still lists the value. Name them instead.
  const alreadyStamped = await count(
    `MATCH (n:MemoryItem) WHERE n.userId IN $retire AND n.legacyUserId IS NOT NULL
     RETURN count(n) AS n`,
    { retire },
  );
  const scopeNote = includeUnscoped
    ? 'including rows with no projectId'
    : 'rows with no projectId skipped';
  console.log(`${LOG} retiring ${retire.join(', ')} → ${retirable} rows (${scopeNote})`);
  if (alreadyStamped > 0) {
    console.log(
      `${LOG} ${alreadyStamped} more carry that value over an existing stamp and are left alone` +
        ' — they were retired once already and written to since.',
    );
  }

  if (stopBeforeWriting()) return;

  await drain(
    'retire',
    `${retirableMatch}
     WITH n LIMIT toInteger($batch)
     SET n.legacyUserId = n.userId
     SET n.userId = NULL
     RETURN count(n) AS n`,
    { retire },
  );
}

main()
  .catch((err) => {
    console.error(`${LOG} failed:`, err);
    process.exit(1);
  })
  .finally(() => closeDriver());
