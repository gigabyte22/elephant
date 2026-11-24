import { Cron } from 'croner';
import type { Container } from '../index.ts';
import type { SchedulerHandle } from './DreamScheduler.ts';

// Hourly, staggered off the other sweeps that share the driver pool: the
// observation reaper (:00), the research reaper (RESEARCH_REAP_CRON, :15), the
// OKF sweep (OKF_SYNC_CRON, 03:30) and the working-state reaper (:55). Odd
// minutes also miss the attachment worker's default even-minute tick.
const PATTERN = '45 * * * *';

/** Named so the job is reachable via croner's `scheduledJobs`, which is how the
 *  unit test fires a tick without waiting on the clock. Mirrors DREAM_JOB_NAME. */
export const INTENTION_REAPER_JOB_NAME = 'intention-reaper';

/**
 * Flips one-time pending intentions overdue by more than
 * INTENTION_EXPIRE_GRACE_DAYS to 'expired' (with an audit event each), so
 * GET /intentions/due stops listing them. Recurring intentions are never
 * touched. The grace period is read by the service from its own config.
 */
export function startIntentionReaper(container: Container): SchedulerHandle {
  const job = new Cron(PATTERN, { name: INTENTION_REAPER_JOB_NAME, protect: true }, async () => {
    try {
      const expired = await container.intentions.reapExpired();
      if (expired > 0) {
        // eslint-disable-next-line no-console
        console.log(`[intention-reaper] expired ${expired} overdue intentions`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[intention-reaper] failed', err);
    }
  });
  return {
    pattern: PATTERN,
    stop: () => job.stop(),
  };
}
