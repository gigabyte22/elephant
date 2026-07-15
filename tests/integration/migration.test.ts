// Asserts the full set of indexes/constraints declared in src/migrate.ts
// is ONLINE after global setup has run. Shared Neo4j container is pre-migrated
// in tests/integration/setup.ts, so this spec only reads SHOW INDEXES.

import { describe, expect, test } from 'vitest';
import { read } from '../../src/config/neo4j.ts';

const EXPECTED_INDEXES = [
  'entity_name',
  'fact_fulltext',
  'fact_temporal',
  'observation_expires',
  'preference_key',
  'episode_agent_id',
  'episode_session',
  'observation_agent_id',
  'chunk_fulltext',
  'fact_vectors',
  'preference_vectors',
  'insight_vectors',
  'episode_vectors',
  'chunk_vectors',
  // Intention (prospective memory)
  'intention_id',
  'intention_due',
  'intention_fulltext',
  'intention_vectors',
];

describe('schema migration', () => {
  test('all declared indexes are ONLINE', async () => {
    const names = await read(async (tx) => {
      const res = await tx.run('SHOW INDEXES YIELD name, state');
      return new Map<string, string>(
        res.records.map((r) => [r.get('name') as string, r.get('state') as string]),
      );
    });

    for (const expected of EXPECTED_INDEXES) {
      expect(names.has(expected), `index ${expected} missing`).toBe(true);
      expect(names.get(expected), `index ${expected} not online`).toBe('ONLINE');
    }
  });
});
