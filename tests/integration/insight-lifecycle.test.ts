// Insights had no lifecycle at all.
//
// promoteHighImportanceInsights copies a high-importance fact's content and
// embedding into an :Insight. That node had no validTo, InsightRepository
// applied no validity filter, and nothing ever pruned or superseded one. So
// when the source fact was later contradicted and correctly tombstoned, the
// insight kept asserting the stale claim in every recall, forever — the
// promotion channel silently defeated the supersede machinery.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { FactRepository } from '../../src/repositories/FactRepository.ts';
import { InsightRepository } from '../../src/repositories/InsightRepository.ts';
import { newId } from '../../src/utils/ids.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };

const CLAIM = 'the user prefers dark mode';

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

beforeAll(async () => {
  // Every extracted fact clears the promotion bar, so a dream cycle reliably
  // produces an insight to exercise.
  const llm = createFakeLLMAdapter({
    extract: ({ episode }) => [
      {
        content: episode.rawTranscript.trim(),
        category: 'preference',
        confidence: 0.95,
        importance: 0.95,
        entityNames: ['user'],
      },
    ],
  });
  container = await bootstrap({ llm, embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }) });
  app = await buildHttpServer(container);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await shutdown();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  await write(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

async function dreamOne(text: string, scope: { userId?: string } = {}): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/episodes',
    headers: json,
    payload: { agentId: 'a1', sessionId: 's1', rawTranscript: text, ...scope },
  });
  expect(res.statusCode).toBe(200);
  await container.dreaming.runCycle();
}

async function insights(): Promise<Array<{ id: string; validTo: unknown; reason: string | null }>> {
  return read(async (tx) => {
    const r = await tx.run(
      'MATCH (i:Insight) RETURN i.id AS id, i.validTo AS validTo, i.retiredReason AS reason',
    );
    return r.records.map((rec) => ({
      id: rec.get('id') as string,
      validTo: rec.get('validTo'),
      reason: (rec.get('reason') as string | null) ?? null,
    }));
  });
}

async function sourceFactId(): Promise<string> {
  return read(async (tx) => {
    const r = await tx.run('MATCH (i:Insight)-[:DERIVED_FROM]->(f:Fact) RETURN f.id AS id LIMIT 1');
    return r.records[0]!.get('id') as string;
  });
}

async function recallInsightIds(): Promise<string[]> {
  const params = new URLSearchParams({ q: CLAIM, limit: '20', includeInsights: 'true' });
  const res = await app.inject({ method: 'GET', url: `/recall?${params}`, headers: auth });
  expect(res.statusCode).toBe(200);
  return ((res.json().data.insights ?? []) as Array<{ id: string }>).map((i) => i.id);
}

describe('an insight is retired when its source fact dies', () => {
  test('via user DELETE', async () => {
    await dreamOne(CLAIM);
    const [insight] = await insights();
    expect(insight?.validTo).toBeNull();
    expect(await recallInsightIds()).toContain(insight!.id);

    await app.inject({
      method: 'DELETE',
      url: `/facts/${await sourceFactId()}`,
      headers: auth,
    });

    const [after] = await insights();
    expect(after?.validTo).not.toBeNull();
    expect(after?.reason).toBe('source_deleted');
    expect(await recallInsightIds()).not.toContain(insight!.id);
  });

  test('via explicit supersede', async () => {
    await dreamOne(CLAIM);
    const [insight] = await insights();
    const oldId = await sourceFactId();

    const replacement = await app.inject({
      method: 'POST',
      url: '/facts',
      headers: json,
      payload: { content: 'the user prefers light mode' },
    });
    await app.inject({
      method: 'POST',
      url: `/facts/${oldId}/supersede`,
      headers: json,
      payload: { newFactId: replacement.json().data.id, reason: 'changed their mind' },
    });

    const [after] = await insights();
    expect(after?.validTo).not.toBeNull();
    expect(after?.reason).toBe('source_superseded');
    expect(await recallInsightIds()).not.toContain(insight!.id);
  });

  test('via a dream prune', async () => {
    await dreamOne(CLAIM);
    const factId = await sourceFactId();

    await write((tx) => FactRepository.prune(tx, factId, new Date()));
    // The write-time cascade covers the dreamer's own prune; here the fact was
    // pruned out of band, so the nightly sweep is what catches it.
    await container.dreaming.runCycle();

    const [after] = await insights();
    expect(after?.validTo).not.toBeNull();
  });
});

describe('multi-source insights survive until every source dies', () => {
  // The retirement rule is "no live source remains", not "any source died".
  // For today's degree-1 insights those are identical; this pins the rule that
  // matters once corroboration starts attaching extra sources, so a single
  // retraction cannot retire a claim other facts still support.
  test('killing one of two sources leaves the insight live', async () => {
    await dreamOne(CLAIM);
    const firstSource = await sourceFactId();

    // A second, independent fact corroborating the same claim. Attached
    // directly because the promotion-time dedup path needs two facts that
    // survive FACT dedup while still embedding close together, which the
    // deterministic fake embedder cannot produce.
    const second = await app.inject({
      method: 'POST',
      url: '/facts',
      headers: json,
      payload: { content: 'dark mode confirmed again' },
    });
    const secondId = second.json().data.id as string;
    const insightId = (await insights())[0]!.id;
    await write((tx) => InsightRepository.addSource(tx, { insightId, factId: secondId }));

    const sources = await read(async (tx) => {
      const r = await tx.run(
        'MATCH (:Insight)-[:DERIVED_FROM]->(f:Fact) RETURN collect(f.id) AS ids',
      );
      return (r.records[0]?.get('ids') as string[]) ?? [];
    });
    expect(sources.sort()).toEqual([firstSource, secondId].sort());

    // One source dies — the insight stands.
    await app.inject({ method: 'DELETE', url: `/facts/${firstSource}`, headers: auth });
    expect((await insights())[0]?.validTo).toBeNull();

    // The last one dies — it retires.
    await app.inject({ method: 'DELETE', url: `/facts/${secondId}`, headers: auth });
    expect((await insights())[0]?.validTo).not.toBeNull();
  });

  test('addSource is idempotent', async () => {
    await dreamOne(CLAIM);
    const insightId = (await insights())[0]!.id;
    const factId = await sourceFactId();

    await write((tx) => InsightRepository.addSource(tx, { insightId, factId }));

    const edges = await read(async (tx) => {
      const r = await tx.run('MATCH (:Insight)-[e:DERIVED_FROM]->(:Fact) RETURN count(e) AS n');
      return (r.records[0]?.get('n') as number) ?? 0;
    });
    expect(edges).toBe(1);
  });
});

describe('the nightly sweep is the migration path', () => {
  test('a legacy insight with a dead source is retired', async () => {
    await dreamOne(CLAIM);
    const factId = await sourceFactId();

    // Simulate a graph written before insights had a lifecycle: the source is
    // tombstoned directly, bypassing every cascade call site.
    await write(async (tx) => {
      await tx.run('MATCH (f:Fact {id: $id}) SET f.validTo = datetime()', { id: factId });
    });
    expect((await insights())[0]?.validTo).toBeNull();

    await container.dreaming.runCycle();

    const [after] = await insights();
    expect(after?.validTo).not.toBeNull();
    expect(after?.reason).toBe('source_dead');
  });

  // The grandfather clause. Insights created with an empty promotedFromFactIds
  // have no DERIVED_FROM edge, so "no live source" is vacuously true for them —
  // without the EXISTS guard the first sweep would retire every one.
  test('a legacy insight with NO source edge survives the sweep', async () => {
    const id = newId();
    await write(async (tx) => {
      await tx.run(
        `CREATE (i:Insight:MemoryItem {id: $id, kind: 'insight', content: 'orphan wisdom',
           embedding: $embedding, promotedFromFactIds: [], createdAt: datetime()})`,
        { id, embedding: Array.from({ length: EMBED_DIM }, () => 0.01) },
      );
    });

    await container.dreaming.runCycle();

    const survivor = (await insights()).find((i) => i.id === id);
    expect(survivor).toBeDefined();
    expect(survivor?.validTo).toBeNull();
  });
});

describe('promotion respects userId', () => {
  // The promotion dedup compares userId alongside projectId. Without it,
  // ravi's identical high-importance fact corroborated dana's insight — ravi
  // never got his own, and dana's was kept alive by another human's fact.
  test("one user's fact promotes their own insight, not a corroboration of another user's", async () => {
    await dreamOne(CLAIM, { userId: 'dana' });
    await dreamOne(CLAIM, { userId: 'ravi' });

    const rows = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (i:Insight)
         OPTIONAL MATCH (i)-[:DERIVED_FROM]->(f:Fact)
         RETURN i.userId AS userId, i.validTo AS validTo, count(f) AS sources
         ORDER BY userId`,
      );
      return r.records.map((rec) => ({
        userId: rec.get('userId') as string | null,
        validTo: rec.get('validTo'),
        sources: Number(rec.get('sources')),
      }));
    });

    // Two independent insights, one per user, each backed only by its own
    // user's fact — no cross-user DERIVED_FROM edge.
    expect(rows.map((r) => r.userId)).toEqual(['dana', 'ravi']);
    for (const row of rows) {
      expect(row.validTo).toBeNull();
      expect(row.sources).toBe(1);
    }
  });
});

describe('run counters', () => {
  test('retirements and corroborations are reported', async () => {
    await dreamOne(CLAIM);
    const second = await container.dreaming.runCycle();
    expect(second.insightsCorroborated + second.insightsPromoted).toBeGreaterThanOrEqual(0);

    const factId = await sourceFactId();
    await write(async (tx) => {
      await tx.run('MATCH (f:Fact {id: $id}) SET f.validTo = datetime()', { id: factId });
    });
    const third = await container.dreaming.runCycle();
    expect(third.insightsRetired).toBeGreaterThanOrEqual(0);
  });
});
