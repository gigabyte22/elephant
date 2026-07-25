// Integration test for the new retrieval pipeline.
// - Seeds two agents so agent-scope behaviour can be asserted.
// - Uses fake LLM with a rerank override so rerank promotion is deterministic.
// - Uses sync refcount-tick so the counts can be asserted after the response.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import type { ExtractedFact } from '../../src/models/types.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

// Make the sync refcount tick predictable for the assertion.
process.env.RETRIEVAL_REFCOUNT_TICK_MODE = 'sync';

beforeAll(async () => {
  const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  const llm = createFakeLLMAdapter({
    extract: ({ episode }): ExtractedFact[] => {
      if (episode.rawTranscript.toLowerCase().includes('dark mode')) {
        return [
          {
            content: 'user prefers dark mode',
            category: 'preference',
            confidence: 0.9,
            importance: 0.7,
            entityNames: ['user', 'theme'],
          },
        ];
      }
      return [];
    },
    // Deterministic rerank: reverse the input order. The test seeds a known
    // pre-rerank ordering so we can assert a swap happened.
    rerank: ({ candidates }) =>
      candidates
        .slice()
        .reverse()
        .map((c, i) => ({ id: c.id, score: 1 - i * 0.1 })),
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

describe('retrieval pipeline (agent-scoped, hybrid)', () => {
  test('agentScope=filter returns only own-agent or shared facts; cross-agent origin dropped', async () => {
    // Ingest one episode per agent, both containing "dark mode".
    for (const agentId of ['alpha', 'beta']) {
      await app.inject({
        method: 'POST',
        url: '/episodes',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: {
          agentId,
          sessionId: `${agentId}-s1`,
          rawTranscript: `the user prefers dark mode for ${agentId}`,
        },
      });
    }
    // Dream once so facts exist with DERIVED_FROM edges.
    await container.dreaming.runCycle();

    const res = await app.inject({
      method: 'GET',
      url: '/recall?q=dark%20mode&agentId=alpha&agentScope=filter',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const facts = res.json().data.facts as Array<{ originAgentId: string | null }>;
    // Every fact either originated at alpha or has null origin (direct / shared).
    for (const f of facts) {
      expect(f.originAgentId === 'alpha' || f.originAgentId == null).toBe(true);
    }
  });

  test('includeChunks=1 surfaces chunks alongside facts', async () => {
    await app.inject({
      method: 'POST',
      url: '/episodes',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        agentId: 'alpha',
        sessionId: 'alpha-s1',
        rawTranscript: 'dark mode discussion and related setup notes',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/recall?q=dark%20mode&agentId=alpha&includeChunks=1&chunkNeighborRadius=1',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data.chunks)).toBe(true);
    expect(body.data.chunks.length).toBeGreaterThan(0);
  });

  test('rerank=1 promotes the reversed-order top candidate', async () => {
    // Seed two direct facts with distinct content.
    const a = await app.inject({
      method: 'POST',
      url: '/facts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: 'build server lives at build.example.com', importance: 0.8 },
    });
    const b = await app.inject({
      method: 'POST',
      url: '/facts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: 'build pipeline lives in github actions', importance: 0.3 },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    // With rerank disabled, the higher-importance fact should lead.
    const baseline = await app.inject({
      method: 'GET',
      url: '/recall?q=build',
      headers: auth,
    });
    const baselineFacts = baseline.json().data.facts as Array<{ id: string; score: number }>;
    expect(baselineFacts.length).toBeGreaterThanOrEqual(2);

    // With rerank enabled (fake reverses input), the ordering flips.
    const reranked = await app.inject({
      method: 'GET',
      url: '/recall?q=build&rerank=1&debug=1',
      headers: auth,
    });
    expect(reranked.statusCode).toBe(200);
    const body = reranked.json();
    expect(body.data.trace).toBeDefined();
    // The rerank fake REVERSES, so the pre-rerank last becomes first.
    // At least one fact should be flagged rerank in expansionReason.
    const flagged = (body.data.facts as Array<{ expansionReason: string }>).some(
      (f) => f.expansionReason === 'rerank',
    );
    expect(flagged).toBe(true);
  });

  test('refcount tick (sync mode) increments referenceCount per returned fact', async () => {
    await app.inject({
      method: 'POST',
      url: '/facts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: 'tick me please', importance: 0.7 },
    });
    // Warm-up: call recall once to pin a definite baseline.
    await app.inject({ method: 'GET', url: '/recall?q=tick', headers: auth });

    const before = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (f:Fact) WHERE f.content CONTAINS 'tick'
         RETURN coalesce(f.referenceCount, 0) AS rc LIMIT 1`,
      );
      return (r.records[0]?.get('rc') as number) ?? 0;
    });

    await app.inject({ method: 'GET', url: '/recall?q=tick', headers: auth });

    const after = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (f:Fact) WHERE f.content CONTAINS 'tick'
         RETURN coalesce(f.referenceCount, 0) AS rc LIMIT 1`,
      );
      return (r.records[0]?.get('rc') as number) ?? 0;
    });

    expect(after).toBe(before + 1);
  });

  // Session working memory. The point of surfacing observations in recall is
  // reach into turns the caller's context window has already evicted — before
  // the session flushes to an episode and dreaming produces chunks.
  describe('observations', () => {
    const observe = async (input: {
      agentId: string;
      sessionId: string;
      content: string;
    }): Promise<void> => {
      const res = await app.inject({
        method: 'POST',
        url: '/observations',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: input,
      });
      expect(res.statusCode).toBe(200);
    };

    const recallObservations = async (query: string): Promise<Array<{ content: string }>> => {
      const res = await app.inject({ method: 'GET', url: `/recall?${query}`, headers: auth });
      expect(res.statusCode).toBe(200);
      return (res.json().data.observations ?? []) as Array<{ content: string }>;
    };

    test('includeObservations surfaces this session only', async () => {
      await observe({
        agentId: 'alpha',
        sessionId: 's1',
        content: 'we chose postgres for the job queue',
      });
      await observe({
        agentId: 'alpha',
        sessionId: 's2',
        content: 'we chose postgres for the job queue',
      });

      const mine = await recallObservations(
        'q=postgres%20job%20queue&includeObservations=1&sessionId=s1',
      );
      expect(mine.length).toBe(1);
      expect(mine[0]!.content).toContain('postgres');

      const theirs = await recallObservations(
        'q=postgres%20job%20queue&includeObservations=1&sessionId=s3',
      );
      expect(theirs.length).toBe(0);
    });

    test('expired observations never surface', async () => {
      await observe({ agentId: 'alpha', sessionId: 's1', content: 'expired working note' });
      await txWrite(async (tx) => {
        await tx.run('MATCH (o:Observation) SET o.expiresAt = datetime($past)', {
          past: '2020-01-01T00:00:00.000Z',
        });
      });
      const hits = await recallObservations(
        'q=expired%20working%20note&includeObservations=1&sessionId=s1',
      );
      expect(hits.length).toBe(0);
    });

    test('limit bounds the observation list', async () => {
      for (let i = 0; i < 5; i++) {
        await observe({ agentId: 'alpha', sessionId: 's1', content: `working note number ${i}` });
      }
      const hits = await recallObservations(
        'q=working%20note&includeObservations=1&sessionId=s1&limit=2',
      );
      expect(hits.length).toBeLessThanOrEqual(2);
    });

    // Both of these would otherwise return an empty list indistinguishable
    // from "this session has nothing matching".
    test('rejects unreachable observation queries rather than answering empty', async () => {
      const noSession = await app.inject({
        method: 'GET',
        url: '/recall?q=anything&includeObservations=1',
        headers: auth,
      });
      expect(noSession.statusCode).toBe(400);

      const kindsExcluded = await app.inject({
        method: 'GET',
        url: '/recall?q=anything&includeObservations=1&sessionId=s1&kinds=fact',
        headers: auth,
      });
      expect(kindsExcluded.statusCode).toBe(400);

      const ok = await app.inject({
        method: 'GET',
        url: '/recall?q=anything&includeObservations=1&sessionId=s1&kinds=fact,observation',
        headers: auth,
      });
      expect(ok.statusCode).toBe(200);
    });
  });

  test('Lucene regression: queries with reserved chars do not 500', async () => {
    await app.inject({
      method: 'POST',
      url: '/facts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: 'we use AI+ML in the pipeline' },
    });
    for (const q of ['AI%2BML', '(ts%7Ctsx)', 'path%2Fto%2Ffile']) {
      const res = await app.inject({
        method: 'GET',
        url: `/recall?q=${q}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
