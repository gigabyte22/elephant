// Verifies the prune pass actually retires stale low-importance facts (the
// pre-fix shouldPrune exempted everything at importance >= 0.1, making the
// pass dead code) while high-importance and recently-referenced facts survive.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import type { Fact } from '../../src/models/types.ts';
import { FactRepository } from '../../src/repositories/FactRepository.ts';
import { newId } from '../../src/utils/ids.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);

let container: Container;
let embedder: ReturnType<typeof createFakeEmbeddingAdapter>;

beforeAll(async () => {
  embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  container = await bootstrap({ llm: createFakeLLMAdapter({}), embedder });
});

afterAll(async () => {
  await shutdown();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

async function seedFact(input: {
  content: string;
  importance: number;
  ageDays: number;
  referenceCount?: number;
}): Promise<string> {
  const recordedAt = new Date(Date.now() - input.ageDays * 86_400_000);
  const fact: Fact = {
    id: newId(),
    content: input.content,
    category: 'attribute',
    confidence: 0.8,
    importance: input.importance,
    validFrom: recordedAt,
    validTo: null,
    recordedAt,
    embedding: await embedder.embed(input.content),
    entityIds: [],
  };
  await txWrite(async (tx) => {
    await FactRepository.create(tx, fact);
    if (input.referenceCount) {
      // create() doesn't persist referenceCount — retrieval bumps it later.
      await tx.run(
        `MATCH (f:Fact {id: $id})
         SET f.referenceCount = $refs, f.lastReferencedAt = f.recordedAt`,
        { id: fact.id, refs: input.referenceCount },
      );
    }
  });
  return fact.id;
}

async function liveFactIds(): Promise<Set<string>> {
  return read(async (tx) => {
    const r = await tx.run('MATCH (f:Fact) WHERE f.validTo IS NULL RETURN f.id AS id');
    return new Set(r.records.map((rec) => rec.get('id') as string));
  });
}

describe('dream prune pass', () => {
  test('stale mid-importance facts prune; important, referenced, and fresh facts survive', async () => {
    const staleTelemetry = await seedFact({
      content: 'run outcome: query completed but tool-heavy',
      importance: 0.3,
      ageDays: 60,
    });
    const staleMid = await seedFact({
      content: 'the project used a temporary staging bucket',
      importance: 0.5,
      ageDays: 60,
    });
    const important = await seedFact({
      content: 'the user lives in Edmonton',
      importance: 0.8,
      ageDays: 400,
    });
    const referenced = await seedFact({
      content: 'the user tracks sleep with a Garmin watch',
      importance: 0.3,
      ageDays: 60,
      referenceCount: 10,
    });
    const fresh = await seedFact({
      content: 'the build currently targets node 22',
      importance: 0.3,
      ageDays: 5,
    });

    const run = await container.dreaming.runCycle();
    expect(run.status).toBe('completed');
    expect(run.factsPruned).toBe(2);

    const live = await liveFactIds();
    expect(live.has(staleTelemetry)).toBe(false);
    expect(live.has(staleMid)).toBe(false);
    expect(live.has(important)).toBe(true);
    expect(live.has(referenced)).toBe(true);
    expect(live.has(fresh)).toBe(true);
  });

  test('prune is a soft delete with an audit trail', async () => {
    const pruned = await seedFact({
      content: 'ephemeral detail nobody asked about again',
      importance: 0.2,
      ageDays: 90,
    });

    const run = await container.dreaming.runCycle();
    expect(run.factsPruned).toBe(1);

    // Tombstoned, not deleted — reversible via SET f.validTo = NULL.
    const tombstone = await read(async (tx) => {
      const r = await tx.run('MATCH (f:Fact {id: $id}) RETURN f.validTo AS validTo', {
        id: pruned,
      });
      return r.records[0]?.get('validTo');
    });
    expect(tombstone).not.toBeNull();

    const events = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (e:AuditEvent {kind: 'prune', targetId: $id}) RETURN e.actor AS actor`,
        { id: pruned },
      );
      return r.records.map((rec) => rec.get('actor') as string);
    });
    expect(events).toEqual(['dreamer']);
  });
});
