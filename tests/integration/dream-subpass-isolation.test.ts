// The graph-wide passes after the episode loop run after the episodes' facts
// are committed, so a throw from any one of them must neither fail the run nor
// skip the passes after it. Promotion, prune and reconcile used to be bare
// awaits: a throw marked the run `failed` and skipped everything behind it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import type { ExtractedFact, Fact } from '../../src/models/types.ts';
import { FactRepository } from '../../src/repositories/FactRepository.ts';
import { InsightRepository } from '../../src/repositories/InsightRepository.ts';
import { newId } from '../../src/utils/ids.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
let embedder: ReturnType<typeof createFakeEmbeddingAdapter>;

beforeAll(async () => {
  embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  const llm = createFakeLLMAdapter({
    // Importance above DREAM_PROMOTE_INSIGHT_IMPORTANCE (0.85) so the
    // extracted fact is a promotion candidate.
    extract: (): ExtractedFact[] => [
      {
        content: 'the user lives in berlin',
        category: 'attribute',
        confidence: 0.9,
        importance: 0.95,
        entityNames: ['berlin'],
      },
    ],
  });
  container = await bootstrap({ llm, embedder });
  app = await buildHttpServer(container);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await shutdown();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedFact(input: {
  content: string;
  importance: number;
  ageDays: number;
  dead?: boolean;
}): Promise<Fact> {
  const recordedAt = new Date(Date.now() - input.ageDays * 86_400_000);
  const fact: Fact = {
    id: newId(),
    content: input.content,
    category: 'attribute',
    confidence: 0.8,
    importance: input.importance,
    validFrom: recordedAt,
    validTo: input.dead ? new Date() : null,
    recordedAt,
    embedding: await embedder.embed(input.content),
    entityIds: [],
  };
  await txWrite((tx) => FactRepository.create(tx, fact));
  return fact;
}

/** One episode to dream (→ one promotable fact), one stale fact for prune, and
 *  one insight whose only source is dead, for reconcile. */
async function seedWork(): Promise<{
  episodeId: string;
  staleFactId: string;
  orphanInsightId: string;
}> {
  const res = await app.inject({
    method: 'POST',
    url: '/episodes',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { agentId: 'test-agent', sessionId: 's1', rawTranscript: 'I live in berlin' },
  });
  expect(res.statusCode).toBe(200);
  const episodeId = res.json().data.episodeId as string;

  const stale = await seedFact({
    content: 'ephemeral detail nobody asked about again',
    importance: 0.2,
    ageDays: 90,
  });

  const deadSource = await seedFact({
    content: 'the user once owned a red bicycle',
    importance: 0.9,
    ageDays: 10,
    dead: true,
  });
  const orphanInsightId = newId();
  await txWrite((tx) =>
    InsightRepository.create(tx, {
      id: orphanInsightId,
      content: deadSource.content,
      embedding: deadSource.embedding,
      promotedFromFactIds: [deadSource.id],
      createdAt: new Date(),
    }),
  );

  return { episodeId, staleFactId: stale.id, orphanInsightId };
}

async function nodeState(id: string): Promise<{ validTo: unknown } | null> {
  return read(async (tx) => {
    const r = await tx.run('MATCH (n {id: $id}) RETURN n.validTo AS validTo', { id });
    const rec = r.records[0];
    return rec ? { validTo: rec.get('validTo') } : null;
  });
}

async function episodeDreamedAt(id: string): Promise<unknown> {
  return read(async (tx) => {
    const r = await tx.run('MATCH (e:Episode {id: $id}) RETURN e.dreamedAt AS d', { id });
    return r.records[0]?.get('d') ?? null;
  });
}

async function liveBerlinFacts(): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(
      `MATCH (f:Fact) WHERE f.validTo IS NULL AND f.content CONTAINS 'berlin'
       RETURN count(f) AS n`,
    );
    return Number(r.records[0]?.get('n') ?? 0);
  });
}

type PassCase = {
  name: string;
  /** Makes one pass throw; absent for the control case. */
  breakPass?: () => void;
  promoted: number;
  pruned: number;
  retired: number;
};

const cases: PassCase[] = [
  { name: 'control: nothing fails, every pass does its work', promoted: 1, pruned: 1, retired: 1 },
  {
    name: 'insight promotion throws',
    breakPass: () => {
      vi.spyOn(InsightRepository, 'create').mockRejectedValue(
        new Error('simulated promote failure'),
      );
    },
    promoted: 0,
    pruned: 1,
    retired: 1,
  },
  {
    name: 'prune throws',
    breakPass: () => {
      vi.spyOn(FactRepository, 'prune').mockRejectedValue(new Error('simulated prune failure'));
    },
    promoted: 1,
    pruned: 0,
    retired: 1,
  },
  {
    name: 'insight reconcile throws',
    breakPass: () => {
      vi.spyOn(InsightRepository, 'retireOrphaned').mockRejectedValue(
        new Error('simulated reconcile failure'),
      );
    },
    promoted: 1,
    pruned: 1,
    retired: 0,
  },
];

describe('dream graph-wide passes are isolated from each other', () => {
  test.each(cases)('$name → run completes, the other passes still run', async (c) => {
    const seeded = await seedWork();
    c.breakPass?.();

    const run = await container.dreaming.runCycle();

    expect(run.status).toBe('completed');
    expect(run.error).toBeFalsy();
    expect(run.episodesProcessed).toBe(1);
    expect(run.factsCreated).toBe(1);
    expect(await episodeDreamedAt(seeded.episodeId)).not.toBeNull();
    expect(await liveBerlinFacts()).toBe(1);

    expect(run.insightsPromoted).toBe(c.promoted);
    expect(run.factsPruned).toBe(c.pruned);
    expect(run.insightsRetired).toBe(c.retired);
    const staleValidTo = (await nodeState(seeded.staleFactId))?.validTo ?? null;
    const orphanValidTo = (await nodeState(seeded.orphanInsightId))?.validTo ?? null;
    expect(staleValidTo !== null).toBe(c.pruned === 1);
    expect(orphanValidTo !== null).toBe(c.retired === 1);
  });
});
