// The research reaper's tick contract, not its Cypher (that is
// tests/integration/research-retention.test.ts). No Neo4j — the container is a
// stub and the job is fired through croner's scheduledJobs registry, the same
// way dream-scheduler.test.ts does it.
//
// The grace period must reach the service unchanged, and a failing sweep must
// not escape as an unhandled rejection: a reaper that dies on one bad tick
// stops reclaiming storage silently, which is the worst way for it to fail.

import { type Cron, scheduledJobs } from 'croner';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Container } from '../../src/index.ts';
import { RESEARCH_REAPER_JOB_NAME, startResearchReaper } from '../../src/jobs/ResearchReaper.ts';

function containerWith(
  purgeExpired: (graceDays: number, limit: number) => Promise<number>,
): Container {
  return {
    env: { RESEARCH_REAP_CRON: '15 * * * *' },
    research: { purgeExpired },
  } as unknown as Container;
}

function reaperJob(): Cron {
  const job = scheduledJobs.find((j) => j.name === RESEARCH_REAPER_JOB_NAME);
  if (!job) throw new Error('research reaper was not registered with croner');
  return job;
}

describe('startResearchReaper', () => {
  let handle: { stop(): void } | null = null;

  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  test('reports the configured cron pattern', () => {
    handle = startResearchReaper(
      containerWith(async () => 0),
      14,
    );
    expect(handle).toMatchObject({ pattern: '15 * * * *' });
  });

  test('sweeps with the configured grace period', async () => {
    const purge = vi.fn(async (_graceDays: number, _limit: number) => 3);
    handle = startResearchReaper(containerWith(purge), 14);

    await reaperJob().trigger();

    expect(purge).toHaveBeenCalledOnce();
    expect(purge.mock.calls[0]?.[0]).toBe(14);
  });

  // A grace of 0 means "purge as soon as it lapses" and must survive the trip
  // intact — `?? default` style handling would silently turn it into 14.
  test('a zero grace period is passed through, not defaulted away', async () => {
    const purge = vi.fn(async (_graceDays: number, _limit: number) => 0);
    handle = startResearchReaper(containerWith(purge), 0);

    await reaperJob().trigger();

    expect(purge.mock.calls[0]?.[0]).toBe(0);
  });

  test('a failing sweep does not escape as an unhandled rejection', async () => {
    const purge = vi.fn(async () => {
      throw new Error('neo4j unreachable');
    });
    handle = startResearchReaper(containerWith(purge), 14);

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(reaperJob().trigger()).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(purge).toHaveBeenCalledOnce();
    expect(unhandled).not.toHaveBeenCalled();
  });

  test('deregisters the job on stop so a restart does not double-schedule', () => {
    handle = startResearchReaper(
      containerWith(async () => 0),
      14,
    );
    expect(scheduledJobs.filter((j) => j.name === RESEARCH_REAPER_JOB_NAME)).toHaveLength(1);

    handle.stop();
    handle = null;

    expect(scheduledJobs.filter((j) => j.name === RESEARCH_REAPER_JOB_NAME)).toHaveLength(0);
  });
});
