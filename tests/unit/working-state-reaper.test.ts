// The working-state reaper's tick contract, not its Cypher (that is
// tests/integration/end-to-end.test.ts). No Neo4j — the container is a stub and
// the job is fired through croner's scheduledJobs registry, the same way
// research-reaper.test.ts does it.

import { type Cron, scheduledJobs } from 'croner';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Container } from '../../src/index.ts';
import {
  startWorkingStateReaper,
  WORKING_STATE_REAPER_JOB_NAME,
} from '../../src/jobs/WorkingStateReaper.ts';

function containerWith(reapExpired: () => Promise<number>): Container {
  return { workingState: { reapExpired } } as unknown as Container;
}

function reaperJob(): Cron {
  const job = scheduledJobs.find((j) => j.name === WORKING_STATE_REAPER_JOB_NAME);
  if (!job) throw new Error('working-state reaper was not registered with croner');
  return job;
}

describe('startWorkingStateReaper', () => {
  let handle: { stop(): void } | null = null;

  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  test('runs hourly, off the other reapers', () => {
    handle = startWorkingStateReaper(containerWith(async () => 0));
    expect(handle).toMatchObject({ pattern: '55 * * * *' });
  });

  test('a tick reaps expired working state', async () => {
    const reap = vi.fn(async () => 2);
    handle = startWorkingStateReaper(containerWith(reap));

    await reaperJob().trigger();

    expect(reap).toHaveBeenCalledOnce();
  });

  test('a failing sweep does not escape as an unhandled rejection', async () => {
    const reap = vi.fn(async () => {
      throw new Error('neo4j unreachable');
    });
    handle = startWorkingStateReaper(containerWith(reap));

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(reaperJob().trigger()).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(reap).toHaveBeenCalledOnce();
    expect(unhandled).not.toHaveBeenCalled();
  });

  test('deregisters the job on stop so a restart does not double-schedule', () => {
    handle = startWorkingStateReaper(containerWith(async () => 0));
    expect(scheduledJobs.filter((j) => j.name === WORKING_STATE_REAPER_JOB_NAME)).toHaveLength(1);

    handle.stop();
    handle = null;

    expect(scheduledJobs.filter((j) => j.name === WORKING_STATE_REAPER_JOB_NAME)).toHaveLength(0);
  });
});
