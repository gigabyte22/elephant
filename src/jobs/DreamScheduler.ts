import { Cron } from 'croner';
import type { Container } from '../index.ts';

export interface SchedulerHandle {
  stop(): void;
  // The currently-scheduled cron expression, useful for /health.
  pattern: string;
}

export function startDreamScheduler(container: Container): SchedulerHandle {
  const pattern = container.env.MEMORY_DREAM_CRON;
  const job = new Cron(pattern, { protect: true }, async () => {
    container.dreaming.trigger();
  });
  return {
    pattern,
    stop: () => job.stop(),
  };
}
