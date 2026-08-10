// Silent recall starvation.
//
// `db.index.vector.queryNodes(index, K, vec)` returns the GLOBAL top-K and
// every predicate in the following WHERE is a post-filter. For a filter of
// selectivity `s`, survivors ≈ K·s — so recall starves whenever K·s < limit,
// and it fails as a 200 with an empty array, indistinguishable from "nothing
// matched". It gets worse as the graph grows, which is the opposite of what an
// operator expects.
//
// sessionId is the worst case: it is the most selective axis in the system and
// was applied entirely as a post-filter, so with N concurrent sessions a
// session-scoped recall returned roughly 1/N of what it should.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { write } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };

const QUERY = 'the build is red on main';

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

beforeAll(async () => {
  container = await bootstrap({
    llm: createFakeLLMAdapter({}),
    embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
  });
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

async function observe(sessionId: string, content: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/observations',
    headers: json,
    payload: { agentId: 'a1', sessionId, content },
  });
  expect(res.statusCode).toBe(200);
}

async function recall(params: Record<string, string>) {
  const qs = new URLSearchParams({ q: QUERY, limit: '10', ...params });
  const res = await app.inject({ method: 'GET', url: `/recall?${qs}`, headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json().data as {
    observations?: Array<{ id: string; sessionId: string }>;
    trace?: {
      candidatesSeen: Record<string, number>;
      sources?: Record<string, { strategy: string; starved: boolean }>;
      starved?: string[];
    };
  };
}

describe('session-scoped observation recall does not starve', () => {
  // The crowding-out case. Session B holds far more observations than the
  // whole ANN budget, all closer to the query than session A's. Under the old
  // post-filter the global top-K was entirely session B, every row was
  // discarded, and session A got an empty list.
  test("a busy neighbouring session does not crowd out the caller's own", async () => {
    for (let i = 0; i < 120; i++) {
      await observe('session-b', `${QUERY} — noisy duplicate ${i}`);
    }
    for (let i = 0; i < 5; i++) {
      await observe('session-a', `${QUERY} (a${i})`);
    }

    const data = await recall({ sessionId: 'session-a', includeObservations: 'true' });

    expect(data.observations ?? []).toHaveLength(5);
    expect((data.observations ?? []).every((o) => o.sessionId === 'session-a')).toBe(true);
  });

  test('an exact-text match in a crowded graph is still found', async () => {
    for (let i = 0; i < 120; i++) {
      await observe('session-b', `${QUERY} — noisy duplicate ${i}`);
    }
    await observe('session-a', QUERY);

    const data = await recall({ sessionId: 'session-a', includeObservations: 'true' });
    expect(data.observations ?? []).toHaveLength(1);
  });

  test('the strategy is reported as a pre-filtered scan, not an ANN query', async () => {
    await observe('session-a', QUERY);
    const data = await recall({
      sessionId: 'session-a',
      includeObservations: 'true',
      debug: 'true',
    });
    expect(data.trace?.sources?.ObservationVectorSource?.strategy).toBe('prefiltered');
    expect(data.trace?.starved ?? []).not.toContain('ObservationVectorSource');
  });

  test('expiry is still enforced', async () => {
    await observe('session-a', QUERY);
    await write(async (tx) => {
      await tx.run('MATCH (o:Observation) SET o.expiresAt = datetime() - duration({days: 1})');
    });

    const data = await recall({ sessionId: 'session-a', includeObservations: 'true' });
    expect(data.observations ?? []).toHaveLength(0);
  });
});

describe('trace reports what was actually seen', () => {
  // candidatesSeen was computed in projectResult, which runs AFTER TopKStage
  // truncates — so it was mathematically incapable of exceeding `limit` and
  // could never reveal that N were fetched and N-limit discarded. That is the
  // exact failure it exists to surface.
  test('candidatesSeen can exceed limit', async () => {
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/facts',
        headers: json,
        payload: { content: `${QUERY} variant ${i}` },
      });
      expect(res.statusCode).toBe(200);
    }

    const data = await recall({ limit: '5', debug: 'true' });
    expect(data.trace?.candidatesSeen.facts).toBeGreaterThan(5);
  });

  test('every source reports its index behaviour', async () => {
    await app.inject({
      method: 'POST',
      url: '/facts',
      headers: json,
      payload: { content: QUERY },
    });

    const data = await recall({ debug: 'true' });
    const fact = data.trace?.sources?.FactVectorSource;
    expect(fact).toBeDefined();
    expect(fact?.starved).toBe(false);
    expect(typeof data.trace?.sources?.FactVectorSource?.strategy).toBe('string');
  });
});

describe('fact scope is pushed into the index', () => {
  test('a project-scoped recall finds its own facts among many others', async () => {
    for (let i = 0; i < 80; i++) {
      await app.inject({
        method: 'POST',
        url: '/facts',
        headers: json,
        payload: { content: `${QUERY} — other project note ${i}`, projectId: 'noisy' },
      });
    }
    await app.inject({
      method: 'POST',
      url: '/facts',
      headers: json,
      payload: { content: `${QUERY} — the one we want`, projectId: 'quiet' },
    });

    const qs = new URLSearchParams({
      q: QUERY,
      limit: '10',
      projectId: 'quiet',
      projectScope: 'strict',
    });
    const res = await app.inject({ method: 'GET', url: `/recall?${qs}`, headers: auth });
    const facts = res.json().data.facts as Array<{ id: string; projectId?: string }>;

    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.projectId === 'quiet')).toBe(true);
  });
});
