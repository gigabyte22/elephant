// The dream cron's overlap behaviour. No Neo4j — the container is a stub and
// the job is fired manually via croner's scheduledJobs registry.
//
// Regression: the callback used to call trigger() bare. trigger() throws
// DreamInProgressError *synchronously* when a run is in flight, croner's
// `catch` defaults to false, and _checkTrigger invokes _trigger() without
// attaching a handler — so an overlapping tick escaped as an unhandled
// rejection and Node 22 killed the process.

import { type Cron, scheduledJobs } from 'croner';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Container } from '../../src/index.ts';
import { DREAM_JOB_NAME, startDreamScheduler } from '../../src/jobs/DreamScheduler.ts';
import { DreamInProgressError } from '../../src/services/DreamingService.ts';

function containerWith(trigger: () => { jobId: string }): Container {
  return {
    env: { MEMORY_DREAM_CRON: '0 3 * * *' },
    dreaming: { trigger },
  } as unknown as Container;
}

function dreamJob(): Cron {
  const job = scheduledJobs.find((j) => j.name === DREAM_JOB_NAME);
  if (!job) throw new Error('dream job was not registered with croner');
  return job;
}

describe('startDreamScheduler', () => {
  let handle: { stop(): void } | null = null;

  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  test('reports the configured cron pattern', () => {
    handle = startDreamScheduler(containerWith(() => ({ jobId: 'j1' })));
    expect(handle).toMatchObject({ pattern: '0 3 * * *' });
  });

  test('fires the dream trigger on tick', async () => {
    const trigger = vi.fn(() => ({ jobId: 'j1' }));
    handle = startDreamScheduler(containerWith(trigger));

    await dreamJob().trigger();

    expect(trigger).toHaveBeenCalledOnce();
  });

  // The crash. An overlapping tick must be swallowed as a benign skip.
  test('survives a tick that overlaps a running dream', async () => {
    const trigger = vi.fn(() => {
      throw new DreamInProgressError('already-running-job');
    });
    handle = startDreamScheduler(containerWith(trigger));

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(dreamJob().trigger()).resolves.toBeUndefined();
      // Let any escaped rejection reach the process handler before asserting.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(trigger).toHaveBeenCalledOnce();
    expect(unhandled).not.toHaveBeenCalled();
  });

  // Any other failure is a real error, but still must not take the process out.
  test('survives an unexpected trigger failure', async () => {
    const trigger = vi.fn(() => {
      throw new Error('neo4j unreachable');
    });
    handle = startDreamScheduler(containerWith(trigger));

    await expect(dreamJob().trigger()).resolves.toBeUndefined();
    expect(trigger).toHaveBeenCalledOnce();
  });

  test('deregisters the job on stop so a restart does not double-schedule', () => {
    handle = startDreamScheduler(containerWith(() => ({ jobId: 'j1' })));
    expect(scheduledJobs.filter((j) => j.name === DREAM_JOB_NAME)).toHaveLength(1);

    handle.stop();
    handle = null;

    expect(scheduledJobs.filter((j) => j.name === DREAM_JOB_NAME)).toHaveLength(0);
  });
});
