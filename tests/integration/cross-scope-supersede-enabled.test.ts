// The other half of cross-scope-supersede.test.ts: DREAM_CROSS_SCOPE_SUPERSEDE
// restores the pre-flag behaviour, where a scoped write may close a fact in the
// unscoped bucket. A single-tenant deployment legitimately wants that — there
// the unscoped bucket is the operator's own, and a correction made inside a
// project should fix it — so the escape hatch has to actually work.
//
// The env is per-file because loadEnv() is memoized and the container is built
// once in beforeAll; the default-off cases live in the sibling file.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { __resetEnvForTests } from '../../src/config/env.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import type { Fact } from '../../src/models/types.ts';
import { FactRepository } from '../../src/repositories/FactRepository.ts';
import { newId } from '../../src/utils/ids.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const PROJECT = 'proj-scoped';
const OLD_CLAIM = 'The user prefers dark mode in the editor';
const NEW_CLAIM = 'The user prefers light mode in the editor';

const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });

let container: Container;

beforeAll(async () => {
  // loadEnv caches across test files in the single-fork runner, so reset it.
  process.env.DREAM_CROSS_SCOPE_SUPERSEDE = 'true';
  process.env.INGEST_SUPERSEDE_MODE = 'inline';
  __resetEnvForTests();
  container = await bootstrap({
    embedder,
    llm: createFakeLLMAdapter({
      supersede: ({ existing }) => {
        const old = existing.find((e) => e.content === OLD_CLAIM);
        return old
          ? { oldFactId: old.id, reason: 'preference reversed', confidenceDelta: 0.1 }
          : null;
      },
    }),
  });
});

afterAll(async () => {
  await shutdown();
  delete process.env.DREAM_CROSS_SCOPE_SUPERSEDE;
  delete process.env.INGEST_SUPERSEDE_MODE;
  __resetEnvForTests();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

/** Backdated past the sweep's grace period, and unjudged by the inline check. */
async function seed(content: string, projectId?: string): Promise<string> {
  const at = new Date(Date.now() - 5 * 60_000);
  const fact: Fact = {
    id: newId(),
    content,
    category: 'preference',
    confidence: 0.8,
    importance: 0.5,
    validFrom: at,
    validTo: null,
    recordedAt: at,
    embedding: await embedder.embed(content),
    entityIds: [],
    projectId,
  };
  await txWrite((tx) => FactRepository.create(tx, fact));
  return fact.id;
}

async function isLive(id: string): Promise<boolean> {
  const fact = await read((tx) => FactRepository.get(tx, id));
  return fact?.validTo == null;
}

describe('DREAM_CROSS_SCOPE_SUPERSEDE=true', () => {
  test('the dream sweep closes a contradicting fact in the unscoped bucket', async () => {
    const shared = await seed(OLD_CLAIM);
    await seed(NEW_CLAIM, PROJECT);

    await container.dreaming.runCycle();

    expect(await isLive(shared)).toBe(false);
  });

  test('the inline POST /facts check closes it too', async () => {
    const shared = await seed(OLD_CLAIM);

    await container.ingestion.saveFact({
      content: NEW_CLAIM,
      category: 'preference',
      projectId: PROJECT,
    });

    expect(await isLive(shared)).toBe(false);
  });

  test('another project’s bucket is still out of reach', async () => {
    // The flag widens to the unscoped bucket only. Project-to-project was
    // never allowed and is not what the escape hatch restores.
    const other = await seed(OLD_CLAIM, 'proj-other');

    await container.ingestion.saveFact({
      content: NEW_CLAIM,
      category: 'preference',
      projectId: PROJECT,
    });

    expect(await isLive(other)).toBe(true);
  });
});
