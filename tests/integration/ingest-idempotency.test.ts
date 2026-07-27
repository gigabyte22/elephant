// EXPECTED.md promises "All writes idempotent via client-supplied id". That
// held for the parent node — every create() MERGEs on id — and failed for
// everything hanging off it.
//
// Chunks were built with a fresh newId() on every call, so re-POSTing produced
// a SECOND full chunk set: new nodes, new HAS_CHUNK edges, a second NEXT chain,
// living permanently in the vector and fulltext indexes, consuming top-K slots
// and double-counted by RRF. Nothing detected or repaired it.
//
// The most likely trigger is the documented safe move: a client retrying after
// a timeout — which is exactly what the shipped client does.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { newId } from '../../src/utils/ids.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };

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

// Long enough to chunk into several pieces at the default target.
const LONG = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i}: the deploy runbook describes rolling back a bad release.`,
).join('\n\n');
const SHORT = 'A single short paragraph.';

async function countNodes(label: string): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(`MATCH (n:${label}) RETURN count(n) AS n`);
    return (r.records[0]?.get('n') as number) ?? 0;
  });
}

async function countEdges(type: string): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(`MATCH ()-[r:${type}]->() RETURN count(r) AS n`);
    return (r.records[0]?.get('n') as number) ?? 0;
  });
}

describe('re-POSTing an episode does not duplicate its chunks', () => {
  test('same id twice leaves exactly one chunk set', async () => {
    const id = newId();
    const payload = { id, agentId: 'a1', sessionId: 's1', rawTranscript: LONG };

    await app.inject({ method: 'POST', url: '/episodes', headers: json, payload });
    const afterFirst = await countNodes('Chunk');
    expect(afterFirst).toBeGreaterThan(1);
    const nextEdges = await countEdges('NEXT');

    // The retry.
    await app.inject({ method: 'POST', url: '/episodes', headers: json, payload });

    expect(await countNodes('Episode')).toBe(1);
    expect(await countNodes('Chunk')).toBe(afterFirst);
    expect(await countEdges('NEXT')).toBe(nextEdges);
    expect(await countEdges('HAS_CHUNK')).toBe(afterFirst);
  });

  test('a shorter body on re-POST leaves no orphaned chunks', async () => {
    const id = newId();
    await app.inject({
      method: 'POST',
      url: '/episodes',
      headers: json,
      payload: { id, agentId: 'a1', sessionId: 's1', rawTranscript: LONG },
    });
    expect(await countNodes('Chunk')).toBeGreaterThan(1);

    // This is why deterministic chunk ids were rejected: they only land on the
    // same node while the chunk COUNT is stable, so a shorter body would strand
    // the surplus — the same bug, quieter.
    await app.inject({
      method: 'POST',
      url: '/episodes',
      headers: json,
      payload: { id, agentId: 'a1', sessionId: 's1', rawTranscript: SHORT },
    });

    expect(await countNodes('Chunk')).toBe(1);
  });
});

describe('re-POSTing research does not duplicate its chunks', () => {
  test('same id twice leaves exactly one chunk set', async () => {
    const id = newId();
    const payload = {
      id,
      title: 'Rollback findings',
      source: 'manual',
      content: LONG,
      projectId: 'acme',
    };

    await app.inject({ method: 'POST', url: '/research', headers: json, payload });
    const afterFirst = await countNodes('ResearchChunk');
    expect(afterFirst).toBeGreaterThan(1);

    await app.inject({ method: 'POST', url: '/research', headers: json, payload });

    expect(await countNodes('Research')).toBe(1);
    expect(await countNodes('ResearchChunk')).toBe(afterFirst);
  });
});

describe('re-POSTing a knowledge document does not duplicate its chunks', () => {
  test('same id twice leaves exactly one chunk set', async () => {
    const id = newId();
    const payload = { id, title: 'Runbook', source: 'wiki', content: LONG };

    await app.inject({ method: 'POST', url: '/knowledge/documents', headers: json, payload });
    const afterFirst = await countNodes('KnowledgeChunk');
    expect(afterFirst).toBeGreaterThan(1);

    await app.inject({ method: 'POST', url: '/knowledge/documents', headers: json, payload });

    expect(await countNodes('KnowledgeDocument')).toBe(1);
    expect(await countNodes('KnowledgeChunk')).toBe(afterFirst);
  });
});

describe('re-POSTing a procedure preserves earned telemetry', () => {
  test('version, successRate and invocationCount survive', async () => {
    const id = newId();
    const create = await app.inject({
      method: 'POST',
      url: '/procedures',
      headers: json,
      payload: { id, name: 'rollback', content: 'step 1', whenToUse: 'bad release' },
    });
    expect(create.statusCode).toBe(200);

    // Simulate accumulated usage the way an orchestrator would report it.
    await app.inject({
      method: 'PUT',
      url: `/procedures/${id}`,
      headers: json,
      payload: { successRate: 0.9, invocationCount: 42 },
    });

    const before = (
      await app.inject({ method: 'GET', url: `/procedures/${id}`, headers: auth })
    ).json().data;
    expect(before.invocationCount).toBe(42);

    // The retry. Previously this reset version to 1, successRate to 0.5 and
    // invocationCount to 0 — silently destroying skill-selection input.
    await app.inject({
      method: 'POST',
      url: '/procedures',
      headers: json,
      payload: { id, name: 'rollback', content: 'step 1', whenToUse: 'bad release' },
    });

    const after = (
      await app.inject({ method: 'GET', url: `/procedures/${id}`, headers: auth })
    ).json().data;
    expect(after.invocationCount).toBe(42);
    expect(after.successRate).toBeCloseTo(0.9);
    expect(after.version).toBe(before.version);
    expect(after.createdAt).toBe(before.createdAt);
  });
});
