// End-to-end coverage for the dream cycle's consolidation pass: fragment
// facts sharing an entity are merged into one canonical fact (via the fake
// LLM), members are tombstoned with SUPERSEDES lineage, provenance and access
// telemetry carry over, and scope buckets never cross.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { __resetEnvForTests } from '../../src/config/env.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import type { Fact } from '../../src/models/types.ts';
import { EntityRepository } from '../../src/repositories/EntityRepository.ts';
import { FactRepository } from '../../src/repositories/FactRepository.ts';
import { newId } from '../../src/utils/ids.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);

// The fake LLM returns whatever the test parks here (null → 'keep' behavior
// upstream because the pass treats null as no-op).
const knobs = {
  consolidateResult: null as {
    decision: 'merge' | 'keep';
    mergeFactIds: string[];
    content: string;
    category?: string;
    confidence: number;
    importance: number;
  } | null,
  consolidateCalls: [] as Array<Array<{ id: string; content: string }>>,
};

let container: Container;
let embedder: ReturnType<typeof createFakeEmbeddingAdapter>;

beforeAll(async () => {
  // The fake embedder's bag-of-tokens vectors put natural paraphrases around
  // cosine 0.65–0.85 — lower the floor so the test sentences cluster together.
  // loadEnv caches across test files in the single-fork runner, so reset it.
  process.env.DREAM_CONSOLIDATION_MIN_SIMILARITY = '0.6';
  __resetEnvForTests();
  embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  const llm = createFakeLLMAdapter({
    consolidate: ({ cluster }) => {
      knobs.consolidateCalls.push(cluster.map((c) => ({ id: c.id, content: c.content })));
      return knobs.consolidateResult;
    },
  });
  container = await bootstrap({ llm, embedder });
});

afterAll(async () => {
  // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
  delete process.env.DREAM_CONSOLIDATION_MIN_SIMILARITY;
  __resetEnvForTests();
  await shutdown();
});

beforeEach(async () => {
  knobs.consolidateResult = null;
  knobs.consolidateCalls = [];
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

async function seedEntity(name: string): Promise<string> {
  const embedding = await embedder.embed(name);
  const entities = await txWrite((tx) =>
    EntityRepository.upsertMany(tx, [{ name, type: 'person', embedding }]),
  );
  return entities[0]!.id;
}

async function seedFact(input: {
  content: string;
  entityIds: string[];
  projectId?: string;
  userId?: string;
  importance?: number;
  confidence?: number;
  referenceCount?: number;
}): Promise<string> {
  const now = new Date();
  const fact: Fact = {
    id: newId(),
    content: input.content,
    category: 'attribute',
    confidence: input.confidence ?? 0.8,
    importance: input.importance ?? 0.6,
    validFrom: now,
    validTo: null,
    recordedAt: now,
    embedding: await embedder.embed(input.content),
    entityIds: input.entityIds,
    projectId: input.projectId,
    userId: input.userId,
  };
  await txWrite(async (tx) => {
    await FactRepository.create(tx, fact);
    if (input.referenceCount) {
      await tx.run(
        `MATCH (f:Fact {id: $id})
         SET f.referenceCount = $refs, f.lastReferencedAt = datetime()`,
        { id: fact.id, refs: input.referenceCount },
      );
    }
  });
  return fact.id;
}

async function getFact(id: string): Promise<(Fact & { live: boolean }) | null> {
  return read(async (tx) => {
    const f = await FactRepository.get(tx, id);
    return f ? { ...f, live: f.validTo === null } : null;
  });
}

describe('dream consolidation pass', () => {
  test('fragments merge into one canonical fact; members tombstone with lineage', async () => {
    const isabelle = await seedEntity('Isabelle');
    const fragA = await seedFact({
      content: 'the user daughter isabelle is six years old',
      entityIds: [isabelle],
      confidence: 0.5,
      importance: 0.5,
      referenceCount: 3,
    });
    const fragB = await seedFact({
      content: 'the user oldest daughter is named isabelle',
      entityIds: [isabelle],
      confidence: 0.8,
      importance: 0.8,
      referenceCount: 4,
    });
    const fragC = await seedFact({
      content: 'the user daughter isabelle is the oldest child',
      entityIds: [isabelle],
      confidence: 0.7,
      importance: 0.7,
    });
    const unrelatedEntity = await seedEntity('Postgres');
    const unrelated = await seedFact({
      content: 'the team chose postgres for the primary database',
      entityIds: [unrelatedEntity],
    });

    knobs.consolidateResult = {
      decision: 'merge',
      mergeFactIds: [fragA, fragB, fragC],
      content: "The user's oldest daughter, Isabelle, is 6 years old.",
      category: 'attribute',
      confidence: 0.9,
      importance: 0.85,
    };

    const run = await container.dreaming.runCycle();
    expect(run.status).toBe('completed');
    expect(run.factsMerged).toBe(1);

    // Members tombstoned; unrelated fact untouched.
    for (const id of [fragA, fragB, fragC]) {
      expect((await getFact(id))?.live).toBe(false);
    }
    expect((await getFact(unrelated))?.live).toBe(true);

    // The canonical fact is live, carries lineage + pooled telemetry.
    const merged = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (f:Fact) WHERE f.mergedFromFactIds IS NOT NULL AND f.validTo IS NULL
         OPTIONAL MATCH (f)-[s:SUPERSEDES]->(old:Fact)
         RETURN f {.*} AS f, collect(old.id) AS supersededIds`,
      );
      expect(r.records).toHaveLength(1);
      return {
        node: r.records[0]!.get('f') as Record<string, unknown>,
        supersededIds: (r.records[0]!.get('supersededIds') as string[]).sort(),
      };
    });
    expect(merged.node.content).toBe("The user's oldest daughter, Isabelle, is 6 years old.");
    expect((merged.node.mergedFromFactIds as string[]).sort()).toEqual(
      [fragA, fragB, fragC].sort(),
    );
    expect(merged.supersededIds).toEqual([fragA, fragB, fragC].sort());
    // supersedesFactId scalar must stay unset for merges.
    expect(merged.node.supersedesFactId ?? null).toBeNull();
    // referenceCount = sum of members (3 + 4 + 0).
    expect(merged.node.referenceCount).toBe(7);
    // Confidence clamped into the members' band [0.5, 0.8 + 0.05] (fp slack).
    expect(merged.node.confidence).toBeLessThanOrEqual(0.85 + 1e-9);
    expect(merged.node.confidence).toBeGreaterThanOrEqual(0.5);

    // Merge audit event written by the dreamer.
    const audit = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (e:AuditEvent {kind: 'merge'}) RETURN e.actor AS actor, e.targetId AS targetId`,
      );
      return r.records.map((rec) => ({
        actor: rec.get('actor') as string,
        targetId: rec.get('targetId') as string,
      }));
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe('dreamer');
    expect(audit[0]!.targetId).toBe(merged.node.id);

    // Dashboard facts view (validTo IS NULL) drops the members.
    const dash = await container.dashboard.topFacts({ sort: 'recent', limit: 10, scope: {} });
    const ids = dash.items.map((f) => f.id);
    expect(ids).toContain(merged.node.id as string);
    for (const id of [fragA, fragB, fragC]) expect(ids).not.toContain(id);
  });

  test('keep decision mutates nothing', async () => {
    const entity = await seedEntity('Isabelle');
    const a = await seedFact({
      content: 'the user daughter isabelle is six years old',
      entityIds: [entity],
    });
    const b = await seedFact({
      content: 'the user daughter isabelle likes drawing pictures',
      entityIds: [entity],
    });
    await seedFact({
      content: 'the user daughter isabelle was born in edmonton',
      entityIds: [entity],
    });

    knobs.consolidateResult = {
      decision: 'keep',
      mergeFactIds: [],
      content: '',
      confidence: 0,
      importance: 0,
    };

    const run = await container.dreaming.runCycle();
    expect(run.factsMerged).toBe(0);
    expect((await getFact(a))?.live).toBe(true);
    expect((await getFact(b))?.live).toBe(true);
  });

  test('facts in different scope buckets never reach the LLM in one cluster', async () => {
    const entity = await seedEntity('Isabelle');
    const mkContent = 'the user daughter isabelle is six years old';
    await seedFact({ content: mkContent, entityIds: [entity], projectId: 'proj-A' });
    await seedFact({ content: mkContent, entityIds: [entity], projectId: 'proj-B' });
    await seedFact({ content: mkContent, entityIds: [entity] });

    // Even a merge-happy LLM can't cross buckets — clusters are all size 1.
    knobs.consolidateResult = {
      decision: 'merge',
      mergeFactIds: [],
      content: 'should never be used',
      confidence: 0.9,
      importance: 0.9,
    };

    const run = await container.dreaming.runCycle();
    expect(run.factsMerged).toBe(0);
    expect(knobs.consolidateCalls).toHaveLength(0);
  });

  test('LLM subset outside the cluster is rejected', async () => {
    const entity = await seedEntity('Isabelle');
    const a = await seedFact({
      content: 'the user daughter isabelle is six years old',
      entityIds: [entity],
    });
    await seedFact({
      content: 'the user daughter isabelle is the oldest child',
      entityIds: [entity],
    });
    await seedFact({
      content: 'the user daughter isabelle is the oldest one',
      entityIds: [entity],
    });

    knobs.consolidateResult = {
      decision: 'merge',
      // One real id + one fabricated — after validation only 1 valid id → keep.
      mergeFactIds: [a, newId()],
      content: 'bogus merge',
      confidence: 0.9,
      importance: 0.9,
    };

    const run = await container.dreaming.runCycle();
    expect(run.factsMerged).toBe(0);
    expect((await getFact(a))?.live).toBe(true);
  });
});
