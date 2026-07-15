// Backfill `origin` on episodes flushed before orchestrators started sending it
// (2026-07-13 provenance work). Heuristics, applied only where origin IS NULL:
//   1. transcript starts with "USER: [CRON_TRIGGER"  → origin 'cron'
//   2. transcript starts with "USER: [EVENT_TRIGGER" → origin 'event'
//   3. transcript starts with "USER: Execute the "   → origin 'system'
//      (project-orchestrator stage prompts)
//   4. sessionId starts with "project:"              → origin 'system'
//      (delegated worker tasks + tool-invoked project queries; NOTE this also
//      catches genuine human chat on a project channel — acceptable for
//      pre-provenance history, where the human text was task-shaped anyway)
// Everything else stays NULL (treated as a normal user conversation).
//
// Dry-run by default; pass --apply to write. Run BEFORE rebuild-facts so the
// re-dream extracts with correct attribution hints.

import { loadEnv } from '../src/config/env.ts';
import { closeDriver, read, write } from '../src/config/neo4j.ts';

const RULES: Array<{ where: string; origin: string; label: string }> = [
  {
    label: 'cron trigger prefix',
    origin: 'cron',
    where: `e.rawTranscript STARTS WITH 'USER: [CRON_TRIGGER'`,
  },
  {
    label: 'event trigger prefix',
    origin: 'event',
    where: `e.rawTranscript STARTS WITH 'USER: [EVENT_TRIGGER'`,
  },
  {
    label: 'stage prompt prefix',
    origin: 'system',
    where: `e.rawTranscript STARTS WITH 'USER: Execute the '`,
  },
  {
    label: 'project session',
    origin: 'system',
    where: `e.sessionId STARTS WITH 'project:'`,
  },
];

async function main(): Promise<void> {
  loadEnv();
  const apply = process.argv.includes('--apply');

  for (const rule of RULES) {
    const matches = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (e:Episode) WHERE e.origin IS NULL AND ${rule.where}
         RETURN e.id AS id, e.agentId AS agentId, e.sessionId AS sessionId`,
      );
      return r.records.map((rec) => ({
        id: rec.get('id') as string,
        agentId: rec.get('agentId') as string,
        sessionId: rec.get('sessionId') as string,
      }));
    });
    console.log(`[backfill-origin] ${rule.label} → '${rule.origin}': ${matches.length} episode(s)`);
    for (const m of matches) {
      console.log(`  ${m.id}  agent=${m.agentId}  session=${m.sessionId}`);
    }
    if (apply && matches.length > 0) {
      await write(async (tx) => {
        await tx.run(
          `MATCH (e:Episode) WHERE e.origin IS NULL AND ${rule.where}
           SET e.origin = $origin`,
          { origin: rule.origin },
        );
      });
      console.log(`[backfill-origin] applied '${rule.origin}' to ${matches.length} episode(s)`);
    }
  }

  const remaining = await read(async (tx) => {
    const r = await tx.run('MATCH (e:Episode) WHERE e.origin IS NULL RETURN count(e) AS n');
    return (r.records[0]?.get('n') as number) ?? 0;
  });
  console.log(
    `[backfill-origin] ${apply ? 'done' : 'dry-run only (pass --apply to write)'}; ${remaining} episode(s) remain origin-less (treated as user conversations).`,
  );
}

main()
  .then(() => closeDriver())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[backfill-origin] failed:', err);
    await closeDriver().catch(() => undefined);
    process.exit(1);
  });
