import { Cron } from 'croner';
import type { Container } from '../index.ts';
import { DreamInProgressError } from '../services/DreamingService.ts';

export interface SchedulerHandle {
  stop(): void;
  // The currently-scheduled cron expression, useful for /health.
  pattern: string;
}

// An overlapping tick must not take the process down.
//
// `protect: true` does NOT guard this job: the callback calls trigger() and
// returns immediately, so croner's blocking flag clears a microtask later. The
// AsyncMutex inside DreamingService is the real overlap guard, and it reports a
// rejected overlap by *throwing* DreamInProgressError. Croner's own `catch`
// defaults to false and it invokes the callback without attaching a handler, so
// an unswallowed throw here surfaces as an unhandled rejection — which Node 22
// turns into process exit. Hence both the try/catch and the `catch` option.
// Named so the job is reachable via croner's `scheduledJobs` — used by the
// unit test to fire a tick deterministically instead of waiting on the clock.
export const DREAM_JOB_NAME = 'elephant-dream';

export function startDreamScheduler(container: Container): SchedulerHandle {
  const pattern = container.env.MEMORY_DREAM_CRON;
  const job = new Cron(
    pattern,
    { name: DREAM_JOB_NAME, protect: true, catch: reportTickError },
    async () => {
      try {
        container.dreaming.trigger();
      } catch (err) {
        reportTickError(err);
      }
    },
  );
  return {
    pattern,
    stop: () => job.stop(),
  };
}

function reportTickError(err: unknown): void {
  if (err instanceof DreamInProgressError) {
    // Benign: a manual POST /dream, or a previous tick still draining a
    // backlog. Skipping is the correct behaviour, so log at info level.
    // eslint-disable-next-line no-console
    console.log(`[dream-cron] skipped tick, run ${err.runningJobId} still in progress`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[dream-cron] trigger failed', err);
}
