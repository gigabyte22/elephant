// One-shot dream cycle. Useful for ops/CI: run after seeding test data, or to
// kick off a backfill consolidation pass without waiting for the cron tick.

import { bootstrap, shutdown } from '../src/index.ts';

async function main(): Promise<void> {
  const container = await bootstrap();
  // eslint-disable-next-line no-console
  console.log(`[dream] starting cycle (llm=${container.llm.name})`);
  const result = await container.dreaming.runCycle();
  // eslint-disable-next-line no-console
  console.log('[dream] result:', {
    id: result.id,
    status: result.status,
    episodesProcessed: result.episodesProcessed,
    factsCreated: result.factsCreated,
    factsSuperseded: result.factsSuperseded,
    factsPruned: result.factsPruned,
    insightsPromoted: result.insightsPromoted,
    durationMs: (result.completedAt ?? new Date()).getTime() - result.startedAt.getTime(),
  });
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('[dream] failed:', err);
    await shutdown().catch(() => undefined);
    process.exit(1);
  });
