import { Cron } from 'croner';
import type { Container } from '../index.ts';
import type { SchedulerHandle } from './DreamScheduler.ts';

// Hourly, staggered off the other sweeps that share the driver pool: the
// observation reaper (:00), the research reaper (RESEARCH_REAP_CRON, :15), the
// OKF sweep (OKF_SYNC_CRON, 03:30) and the intention reaper (:45). Odd minutes
// also miss the attachment worker's default even-minute tick.
const PATTERN = '55 * * * *';

/** Named so the job is reachable via croner's `scheduledJobs`, which is how the
 *  unit test fires a tick without waiting on the clock. Mirrors DREAM_JOB_NAME. */
export const WORKING_STATE_REAPER_JOB_NAME = 'working-state-reaper';

/**
 * Deletes expired `:WorkingState` nodes (at most 5000 per tick). Reads already
 * hide expired entries, so this only reclaims storage. On the Redis backend
 * the adapter has no-op reaping — Redis expires keys natively.
 */
export function startWorkingStateReaper(container: Container): SchedulerHandle {
  const job = new Cron(
    PATTERN,
    { name: WORKING_STATE_REAPER_JOB_NAME, protect: true },
    async () => {
      try {
        const deleted = await container.workingState.reapExpired();
        if (deleted > 0) {
          // eslint-disable-next-line no-console
          console.log(`[working-state-reaper] deleted ${deleted} expired working-state entries`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[working-state-reaper] failed', err);
      }
    },
  );
  return {
    pattern: PATTERN,
    stop: () => job.stop(),
  };
}
