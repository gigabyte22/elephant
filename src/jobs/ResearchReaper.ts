import { Cron } from 'croner';
import type { Container } from '../index.ts';
import type { SchedulerHandle } from './DreamScheduler.ts';

// One tick's ceiling, matching the observation reaper. A larger backlog drains
// over successive ticks rather than holding one long write transaction.
const BATCH = 1000;

/** Named so the job is reachable via croner's `scheduledJobs`, which is how the
 *  unit test fires a tick without waiting on the clock. Mirrors DREAM_JOB_NAME. */
export const RESEARCH_REAPER_JOB_NAME = 'research-reaper';

/**
 * Releases storage for research whose expiry lapsed more than `graceDays` ago.
 *
 * This is the only automatic hard delete of a `:MemoryItem` in the service —
 * every other tier soft-deletes and keeps the node forever — so an existing
 * deployment must never start deleting on upgrade. `scripts/serve.ts` starts
 * this job only when RESEARCH_RETENTION_DAYS is set.
 *
 * `graceDays` is a parameter rather than another `container.env` read (the
 * shape the other jobs use) precisely because of that gate: the variable is
 * optional with no default, and taking it as a `number` puts the "is it set?"
 * decision in the one place that also decides whether to start the job.
 */
export function startResearchReaper(container: Container, graceDays: number): SchedulerHandle {
  const pattern = container.env.RESEARCH_REAP_CRON;
  const job = new Cron(pattern, { name: RESEARCH_REAPER_JOB_NAME, protect: true }, async () => {
    try {
      const deleted = await container.research.purgeExpired(graceDays, BATCH);
      if (deleted > 0) {
        // eslint-disable-next-line no-console
        console.log(`[research-reaper] purged ${deleted} expired research documents`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[research-reaper] failed', err);
    }
  });
  return {
    pattern,
    stop: () => job.stop(),
  };
}
