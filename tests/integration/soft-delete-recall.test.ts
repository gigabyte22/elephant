// Soft-deleted narrative documents must stop answering /recall.
//
// Both kinds implement soft-delete as `expiresAt = now`, and both had a hole:
//   - KnowledgeChunk searches never joined the parent, so a deleted document's
//     chunks kept matching forever (chunks are only physically removed under
//     ?purge=true, which is opt-in).
//   - ResearchRepository.listSimilar had no expiry predicate, so a deleted
//     research item still surfaced its title/summary through the node-level
//     vector source even after the 2026-07-20 chunk-side fix.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read as txRead, write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };
const PROJECT = 'proj-soft-delete';

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
  await app?.close();
  await shutdown();
});

async function clearDb(): Promise<void> {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
}

// The fake embedder is deterministic on its input, so querying with the exact
// stored text guarantees a top hit — the "before" assertion is about the
// liveness predicate, not about similarity tuning.
const DOC_TEXT =
  'Rollback runbook: drain the queue, flip the feature flag, then redeploy the previous tag.';
const RESEARCH_TEXT =
  'Findings: the dual-store design lost to a single Neo4j instance on operational cost.';

async function recall(q: string, extra: Record<string, string>) {
  const params = new URLSearchParams({ q, limit: '20', ...extra });
  const res = await app.inject({ method: 'GET', url: `/recall?${params}`, headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json().data as {
    knowledgeChunks?: Array<{ id: string }>;
    research?: Array<{ id: string }>;
    researchChunks?: Array<{ id: string }>;
  };
}

async function countNodes(label: string): Promise<number> {
  return txRead(async (tx) => {
    const r = await tx.run(`MATCH (n:${label}) RETURN count(n) AS n`);
    return (r.records[0]?.get('n') as number) ?? 0;
  });
}

describe('soft-deleted knowledge documents', () => {
  test('stop answering recall while their chunks remain in the graph', async () => {
    await clearDb();
    const created = await app.inject({
      method: 'POST',
      url: '/knowledge/documents',
      headers: json,
      payload: { title: 'Rollback runbook', source: 'wiki', content: DOC_TEXT },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().data.id as string;

    const before = await recall(DOC_TEXT, { includeKnowledge: 'true' });
    expect(before.knowledgeChunks?.length ?? 0).toBeGreaterThan(0);

    // No ?purge — the default delete, which is what a caller reaching for
    // "forget this document" actually sends.
    const del = await app.inject({
      method: 'DELETE',
      url: `/knowledge/documents/${id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data).toMatchObject({ deleted: true, chunksDeleted: 0 });

    const after = await recall(DOC_TEXT, { includeKnowledge: 'true' });
    expect(after.knowledgeChunks ?? []).toHaveLength(0);

    // Direct read-by-id deliberately still succeeds — nothing is hard-deleted,
    // and the deletion is observable as a stamped expiresAt rather than a 404.
    // The gate belongs on the *search* paths (recall, list), not on inspection.
    const got = await app.inject({
      method: 'GET',
      url: `/knowledge/documents/${id}`,
      headers: auth,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().data.expiresAt).not.toBeNull();

    // The chunks are still physically present: it is the parent-liveness join
    // suppressing them, not deletion. Keeps ?purge=true meaningful as the
    // "also reclaim storage" step rather than "make delete actually work".
    expect(await countNodes('KnowledgeChunk')).toBeGreaterThan(0);
  });

  test('purge additionally removes the chunk nodes', async () => {
    await clearDb();
    const created = await app.inject({
      method: 'POST',
      url: '/knowledge/documents',
      headers: json,
      payload: { title: 'Rollback runbook', source: 'wiki', content: DOC_TEXT },
    });
    const id = created.json().data.id as string;

    const del = await app.inject({
      method: 'DELETE',
      url: `/knowledge/documents/${id}?purge=true`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.chunksDeleted).toBeGreaterThan(0);
    expect(await countNodes('KnowledgeChunk')).toBe(0);
  });
});

describe('soft-deleted research', () => {
  test('stops answering recall on both the node and chunk sources', async () => {
    await clearDb();
    const created = await app.inject({
      method: 'POST',
      url: '/research',
      headers: json,
      payload: {
        title: 'Dual-store vs single Neo4j',
        source: 'manual',
        content: RESEARCH_TEXT,
        projectId: PROJECT,
      },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().data.id as string;

    const before = await recall(RESEARCH_TEXT, {
      includeResearch: 'true',
      projectId: PROJECT,
    });
    expect(before.research?.some((r) => r.id === id)).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/research/${id}`, headers: auth });
    expect(del.statusCode).toBe(200);

    const after = await recall(RESEARCH_TEXT, {
      includeResearch: 'true',
      projectId: PROJECT,
    });
    expect(after.research ?? []).toHaveLength(0);
    expect(after.researchChunks ?? []).toHaveLength(0);

    // The node itself survives — soft-delete, not erasure — and stays readable
    // by id with expiresAt stamped. Recall and list are gated; inspection is
    // not. Keeping both assertions here pins that distinction so a future
    // "make delete actually delete" change has to confront it deliberately.
    expect(await countNodes('Research')).toBe(1);
    const got = await app.inject({ method: 'GET', url: `/research/${id}`, headers: auth });
    expect(got.statusCode).toBe(200);
    expect(got.json().data.expiresAt).not.toBeNull();
  });
});
