// Contradiction supersede must not reach out of the writer's own scope.
//
// Cross-scope *dedup* is read-only — a scoped write that declines to store a
// fact the unscoped bucket already holds loses nothing, because the reader
// sees that bucket anyway. Supersede is not: it closes the older fact and
// writes the replacement into the EPISODE's scope. Widened, that takes a fact
// out of a bucket several accounts read and moves its successor into one
// account's private scope — and the insights derived from it are retired as
// `source_dead` on the next cycle.
//
// So the widening is now its own flag, off by default. These pin the default;
// cross-scope-supersede-enabled.test.ts pins the escape hatch.
//
// Runs with INGEST_SUPERSEDE_MODE=inline so the third supersede writer — the
// one on the POST /facts request path — is covered too. It had widened
// unconditionally, ignoring even the dedup flag.

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

// Close enough to clear the supersede floor (0.85), far enough to stay under
// the dedup threshold (0.92) — the same pairing supersede-sweep.test.ts uses.
const OLD_CLAIM = 'The user prefers dark mode in the editor';
const NEW_CLAIM = 'The user prefers light mode in the editor';

const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });

let container: Container;
/** When set, the judge names this id whatever it was actually offered. */
let forcedOldFactId: string | null = null;
let offered: string[][];

beforeAll(async () => {
  // loadEnv caches across test files in the single-fork runner, so reset it.
  process.env.INGEST_SUPERSEDE_MODE = 'inline';
  __resetEnvForTests();
  offered = [];
  container = await bootstrap({
    embedder,
    llm: createFakeLLMAdapter({
      supersede: ({ existing }) => {
        offered.push(existing.map((e) => e.content));
        if (forcedOldFactId) {
          return { oldFactId: forcedOldFactId, reason: 'forced', confidenceDelta: 0 };
        }
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
  delete process.env.INGEST_SUPERSEDE_MODE;
  __resetEnvForTests();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  offered = [];
  forcedOldFactId = null;
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

/**
 * Write a fact straight to the repository, bypassing the ingestion service —
 * the sweep cases need a fact the inline check has not already judged, and
 * one backdated past the sweep's settling grace period.
 */
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

describe('the dream supersede sweep, cross-scope off (the default)', () => {
  test('leaves a fact in the unscoped bucket alone', async () => {
    const shared = await seed(OLD_CLAIM);
    await seed(NEW_CLAIM, PROJECT);

    await container.dreaming.runCycle();

    expect(await isLive(shared)).toBe(true);
    // Not merely unpicked by the judge — never offered to it.
    expect(offered.flat()).not.toContain(OLD_CLAIM);
  });

  test('still closes a contradiction inside the writer’s own bucket', async () => {
    const old = await seed(OLD_CLAIM, PROJECT);
    await seed(NEW_CLAIM, PROJECT);

    await container.dreaming.runCycle();

    expect(await isLive(old)).toBe(false);
  });
});

describe('POST /facts with INGEST_SUPERSEDE_MODE=inline', () => {
  test('leaves a fact in the unscoped bucket alone', async () => {
    const shared = await seed(OLD_CLAIM);

    await container.ingestion.saveFact({
      content: NEW_CLAIM,
      category: 'preference',
      projectId: PROJECT,
    });

    expect(await isLive(shared)).toBe(true);
    expect(offered.flat()).not.toContain(OLD_CLAIM);
  });

  test('ignores a judge naming a fact outside the candidate set', async () => {
    // The judge is told which facts it may pick from, but nothing makes it
    // obey. An id echoed from outside that set — the new fact's own id
    // included — would close a row the scope search deliberately excluded.
    const shared = await seed(OLD_CLAIM);
    const inBucket = await seed(OLD_CLAIM, PROJECT);
    forcedOldFactId = shared;

    await container.ingestion.saveFact({
      content: NEW_CLAIM,
      category: 'preference',
      projectId: PROJECT,
    });

    // The judge was consulted — the in-bucket fact was a real candidate — and
    // its out-of-set answer was discarded whole rather than redirected.
    expect(offered.flat()).toContain(OLD_CLAIM);
    expect(await isLive(shared)).toBe(true);
    expect(await isLive(inBucket)).toBe(true);
  });
});
