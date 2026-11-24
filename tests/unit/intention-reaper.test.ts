// The intention reaper's tick contract, not its Cypher (that is
// tests/integration/intentions.test.ts). No Neo4j — the container is a stub and
// the job is fired through croner's scheduledJobs registry, the same way
// research-reaper.test.ts does it.

import { type Cron, scheduledJobs } from 'croner';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Container } from '../../src/index.ts';
import { INTENTION_REAPER_JOB_NAME, startIntentionReaper } from '../../src/jobs/IntentionReaper.ts';

function containerWith(reapExpired: () => Promise<number>): Container {
  return { intentions: { reapExpired } } as unknown as Container;
}

function reaperJob(): Cron {
  const job = scheduledJobs.find((j) => j.name === INTENTION_REAPER_JOB_NAME);
  if (!job) throw new Error('intention reaper was not registered with croner');
  return job;
}

describe('startIntentionReaper', () => {
  let handle: { stop(): void } | null = null;

  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  test('runs hourly, off the other reapers', () => {
    handle = startIntentionReaper(containerWith(async () => 0));
    expect(handle).toMatchObject({ pattern: '45 * * * *' });
  });

  test('a tick reaps expired intentions', async () => {
    const reap = vi.fn(async () => 2);
    handle = startIntentionReaper(containerWith(reap));

    await reaperJob().trigger();

    expect(reap).toHaveBeenCalledOnce();
  });

  test('a failing sweep does not escape as an unhandled rejection', async () => {
    const reap = vi.fn(async () => {
      throw new Error('neo4j unreachable');
    });
    handle = startIntentionReaper(containerWith(reap));

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
    handle = startIntentionReaper(containerWith(async () => 0));
    expect(scheduledJobs.filter((j) => j.name === INTENTION_REAPER_JOB_NAME)).toHaveLength(1);

    handle.stop();
    handle = null;

    expect(scheduledJobs.filter((j) => j.name === INTENTION_REAPER_JOB_NAME)).toHaveLength(0);
  });
});
