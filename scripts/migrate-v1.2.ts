// v1.2 backfill — add `:MemoryItem` base label and `kind` property to every
// pre-existing memory node. Idempotent: safe to re-run, only touches nodes
// that don't already carry the label.

import { closeDriver, write } from '../src/config/neo4j.ts';
import type { MemoryKind } from '../src/models/types.ts';

interface BackfillStep {
  label: string;
  kind: MemoryKind;
}

const STEPS: BackfillStep[] = [
  { label: 'Episode', kind: 'episode' },
  { label: 'Chunk', kind: 'chunk' },
  { label: 'Fact', kind: 'fact' },
  { label: 'Preference', kind: 'preference' },
  { label: 'Insight', kind: 'insight' },
  { label: 'Observation', kind: 'observation' },
];

async function backfillStep(step: BackfillStep, log: (m: string) => void): Promise<void> {
  const updated = await write(async (tx) => {
    const res = await tx.run(
      `MATCH (n:${step.label})
       WHERE NOT 'MemoryItem' IN labels(n) OR n.kind IS NULL
       SET n:MemoryItem, n.kind = $kind
       RETURN count(n) AS updated`,
      { kind: step.kind },
    );
    const record = res.records[0];
    return record ? Number(record.get('updated') ?? 0) : 0;
  });
  log(`[v1.2] ${step.label} -> :MemoryItem kind='${step.kind}': ${updated} node(s) updated`);
}

export async function migrateV12(opts: { log?: (msg: string) => void } = {}): Promise<void> {
  const log = opts.log ?? (() => undefined);
  log('[v1.2] starting hybrid-label backfill');
  for (const step of STEPS) {
    await backfillStep(step, log);
  }
  log('[v1.2] backfill complete');
}

// Run as a script when invoked directly (tsx scripts/migrate-v1.2.ts).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  migrateV12({ log: (msg) => console.log(msg) })
    .then(() => closeDriver())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[v1.2] failed:', err);
      await closeDriver().catch(() => undefined);
      process.exit(1);
    });
}
