// End-to-end integration: Neo4j (testcontainer) + full Fastify HTTP surface
// + fake adapters. Asserts the EXPECTED.md envelope shape on every endpoint
// and verifies bi-temporal supersede + dream cycle behavior.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import type { ExtractedFact } from '../../src/models/types.ts';
import { assertDestructiveAllowed } from './guard.ts';

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  // The dream LLM stub: extract one fact whose content matches the latest episode keyword.
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
  });
  const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  container = await bootstrap({ llm, embedder });
  app = await buildHttpServer(container);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await shutdown();
});

async function clearDb(): Promise<void> {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
}

describe('end-to-end memory service', () => {
  test('GET /health returns ok envelope and adapter info', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.neo4j).toBe(true);
    expect(body.data.embedder.name).toContain('fake-embed');
    expect(body.data.embedder.dim).toBe(EMBED_DIM);
    expect(body.data.schemaVectorDim).toBe(EMBED_DIM);
  });

  test('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/preferences' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  test('POST /facts → GET /recall round-trips with envelope shape', async () => {
    await clearDb();
    const factRes = await app.inject({
      method: 'POST',
      url: '/facts',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: 'the build server lives at build.example.com', importance: 0.7 },
    });
    expect(factRes.statusCode).toBe(200);
    const factBody = factRes.json();
    expect(factBody.ok).toBe(true);
    expect(factBody.data.content).toBe('the build server lives at build.example.com');
    expect(typeof factBody.data.id).toBe('string');

    const recallRes = await app.inject({
      method: 'GET',
      url: '/recall?q=build%20server&limit=5',
      headers: auth,
    });
    expect(recallRes.statusCode).toBe(200);
    const recallBody = recallRes.json();
    expect(recallBody.ok).toBe(true);
    expect(recallBody.data.facts.length).toBeGreaterThanOrEqual(1);
    expect(recallBody.data.facts[0].content).toContain('build server');
  });

  test('PUT /preferences supersedes prior value; /timeline returns historical state', async () => {
    await clearDb();
    const t0 = new Date();
    await app.inject({
      method: 'PUT',
      url: '/preferences/theme',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { value: 'dark' },
    });
    // Hold the timestamp between the two writes so the snapshot can target it.
    await new Promise((r) => setTimeout(r, 50));
    const tBetween = new Date();
    await new Promise((r) => setTimeout(r, 50));
    await app.inject({
      method: 'PUT',
      url: '/preferences/theme',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { value: 'light' },
    });

    const cur = await app.inject({
      method: 'GET',
      url: '/preferences/theme',
      headers: auth,
    });
    expect(cur.json().data.value).toBe('light');

    const past = await app.inject({
      method: 'GET',
      url: `/timeline?at=${tBetween.toISOString()}&preferenceKey=theme`,
      headers: auth,
    });
    expect(past.statusCode).toBe(200);
    expect(past.json().data.preference?.value).toBe('dark');
    // Bracket-check: t0 predates both writes; should yield no preference.
    const before = await app.inject({
      method: 'GET',
      url: `/timeline?at=${new Date(t0.getTime() - 1000).toISOString()}&preferenceKey=theme`,
      headers: auth,
    });
    expect(before.json().data.preference).toBeNull();
  });

  test('POST /dream extracts facts from episodes; status reflects completion', async () => {
    await clearDb();
    await app.inject({
      method: 'POST',
      url: '/episodes',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        agentId: 'test-agent',
        sessionId: 's1',
        rawTranscript: 'hey, switch the UI to dark mode please.',
      },
    });

    // Run dream cycle synchronously via the service so the test is deterministic
    // (the HTTP /dream is fire-and-forget).
    const run = await container.dreaming.runCycle();
    expect(run.status).toBe('completed');
    expect(run.episodesProcessed).toBe(1);
    expect(run.factsCreated).toBeGreaterThanOrEqual(1);

    const recall = await app.inject({
      method: 'GET',
      url: '/recall?q=dark%20mode',
      headers: auth,
    });
    const facts = recall.json().data.facts as Array<{ content: string }>;
    expect(facts.some((f) => f.content.includes('dark mode'))).toBe(true);
  });

  test('POST /observations writes session-scoped working memory', async () => {
    await clearDb();
    const w = await app.inject({
      method: 'POST',
      url: '/observations',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        agentId: 'test-agent',
        sessionId: 'sess-x',
        content: 'currently focused on the auth flow',
      },
    });
    expect(w.statusCode).toBe(200);
    const r = await app.inject({
      method: 'GET',
      url: '/observations?sessionId=sess-x',
      headers: auth,
    });
    expect(r.json().data.observations).toHaveLength(1);
    expect(r.json().data.observations[0].content).toBe('currently focused on the auth flow');
  });
});
