import { Cron } from 'croner';
import type { Container } from '../index.ts';
import type { SchedulerHandle } from './DreamScheduler.ts';

const HOURLY = '0 * * * *';

export function startObservationReaper(container: Container): SchedulerHandle {
  const job = new Cron(HOURLY, { protect: true }, async () => {
    try {
      const deleted = await container.observations.reapExpired();
      if (deleted > 0) {
        // eslint-disable-next-line no-console
        console.log(`[reaper] deleted ${deleted} expired observations`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[reaper] failed', err);
    }
  });
  return {
    pattern: HOURLY,
    stop: () => job.stop(),
  };
}
