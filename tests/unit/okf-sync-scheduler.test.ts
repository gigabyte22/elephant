// The vault body policy and the sync scheduler's wiring. No Neo4j, no fs —
// the scheduler is constructed but never fires (croner only runs on tick).

import { describe, expect, test } from 'vitest';
import { bodyFor } from '../../src/adapters/vault/frontmatter.ts';
import type { Container } from '../../src/index.ts';
import { startOkfSyncScheduler } from '../../src/jobs/OkfSyncScheduler.ts';

describe('bodyFor', () => {
  test('uses retained content verbatim', () => {
    expect(bodyFor({ content: '## Findings\n\np99 regressed.', summary: 'ignored' })).toBe(
      '## Findings\n\np99 regressed.',
    );
  });

  test('falls back to summary plus a not-retained note for pre-OKF rows', () => {
    const body = bodyFor({ summary: 'Traced the regression.' });
    expect(body).toBe(
      'Traced the regression.\n\n> body not retained (pre-OKF record; only the summary survives)',
    );
  });

  // An empty string is a pre-OKF row too — `??` would have let it through as
  // an empty body, silently producing a contentless vault file.
  test('treats empty content as not retained', () => {
    expect(bodyFor({ content: '', summary: 'Only a summary.' })).toContain('body not retained');
  });
});

describe('startOkfSyncScheduler', () => {
  const containerWith = (cron: string) =>
    ({ env: { OKF_SYNC_CRON: cron, OKF_DIR: './.okf-vault' } }) as unknown as Container;

  test('reports the configured cron pattern and stops cleanly', () => {
    const handle = startOkfSyncScheduler(containerWith('30 3 * * *'));
    expect(handle.pattern).toBe('30 3 * * *');
    expect(() => handle.stop()).not.toThrow();
  });

  // The default is deliberately offset from MEMORY_DREAM_CRON's `0 3 * * *`
  // so the sweep does not contend with the dream cycle on the same driver.
  test('does not collide with the dream cycle slot', async () => {
    const { loadEnv, __resetEnvForTests } = await import('../../src/config/env.ts');
    __resetEnvForTests();
    const env = loadEnv();
    expect(env.OKF_SYNC_CRON).not.toBe(env.MEMORY_DREAM_CRON);
  });
});
