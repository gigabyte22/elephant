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
// `protect: true` does NOT guard this job: the callback returns as soon as
// trigger() has started the cycle, so croner's blocking flag clears long before
// the cycle ends. The AsyncMutex inside DreamingService is the real overlap
// guard, and it reports a rejected overlap by *throwing* DreamInProgressError.
// Croner's own `catch` defaults to false and it invokes the callback without
// attaching a handler, so an unswallowed throw here surfaces as an unhandled rejection — which Node 22
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
      await reconcileStaleRuns(container);
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

// Fail DreamRun rows abandoned by a process that died mid-cycle, so a
// hard-killed run heals on the next tick rather than at the next restart. The
// age threshold inside reconcileStaleRuns keeps a genuinely running cycle —
// this process's or another's, such as a manual `pnpm dream` — untouched.
// Best-effort: a failure is logged and the tick goes on to trigger.
async function reconcileStaleRuns(container: Container): Promise<void> {
  try {
    const reaped = await container.dreaming.reconcileStaleRuns();
    if (reaped > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[dream-cron] marked ${reaped} abandoned dream run(s) as failed`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dream-cron] could not reconcile stale dream runs', err);
  }
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
