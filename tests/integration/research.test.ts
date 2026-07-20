// Integration test for research body retention: the full content posted to
// /research must be persisted on the node and returned by the read paths,
// alongside the sha256 contentHash the service already computed.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { ResearchChunkRepository } from '../../src/repositories/ResearchChunkRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

// Spy on embed() so tests can assert "did / didn't re-embed" on update.
let embedCalls: string[] = [];

beforeAll(async () => {
  const base = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  const embedder = {
    ...base,
    embed: async (text: string): Promise<number[]> => {
      embedCalls.push(text);
      return base.embed(text);
    },
  };
  const llm = createFakeLLMAdapter({});
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
  embedCalls = [];
}

const PROJECT = 'proj-research-body';

async function createResearch(content: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/research',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: {
      title: 'Neo4j vs dual-store for agent memory',
      source: 'manual',
      content,
      projectId: PROJECT,
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

describe('research body retention', () => {
  test('POST → GET returns content verbatim with matching contentHash', async () => {
    await clearDb();
    const content = '# Findings\n\nElephant used to drop research bodies after ingest.\n';
    const id = await createResearch(content);

    const res = await app.inject({ method: 'GET', url: `/research/${id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.content).toBe(content);
    expect(data.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
  });

  test('list carries content', async () => {
    await clearDb();
    const content = 'short research note body';
    const id = await createResearch(content);

    const res = await app.inject({
      method: 'GET',
      url: `/research?projectId=${PROJECT}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string; content?: string }>;
    expect(rows.find((r) => r.id === id)?.content).toBe(content);
  });

  test('PUT title only → no re-embed, hash/summary unchanged, revision recorded', async () => {
    await clearDb();
    const content = 'stable body that must not be re-embedded';
    const id = await createResearch(content);
    const embedsAfterCreate = embedCalls.length;

    const res = await app.inject({
      method: 'PUT',
      url: `/research/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'renamed', actor: 'tester' },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.title).toBe('renamed');
    expect(data.content).toBe(content);
    expect(data.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(embedCalls.length).toBe(embedsAfterCreate);

    const audit = await app.inject({ method: 'GET', url: `/audit/${id}`, headers: auth });
    const { revisions, events } = audit.json().data;
    expect(revisions).toHaveLength(1);
    expect(events.some((e: { kind: string }) => e.kind === 'update')).toBe(true);
  });

  test('PUT new content → new hash + summary, revision snapshots the OLD content sans embedding', async () => {
    await clearDb();
    const original = 'original research body';
    const replacement = 'completely different findings';
    const id = await createResearch(original);

    const res = await app.inject({
      method: 'PUT',
      url: `/research/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: replacement, reason: 'refreshed findings' },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.content).toBe(replacement);
    expect(data.contentHash).toBe(createHash('sha256').update(replacement).digest('hex'));
    expect(data.summary).toBe(replacement); // short content doubles as summary

    const audit = await app.inject({ method: 'GET', url: `/audit/${id}`, headers: auth });
    const { revisions } = audit.json().data;
    expect(revisions).toHaveLength(1);
    // toWireArchivedRevision already deserializes the snapshot JSON.
    const snapshot = revisions[0].snapshot;
    expect(snapshot.content).toBe(original);
    expect(snapshot).not.toHaveProperty('embedding');
  });

  test('PUT identical content → revision recorded but no re-embed', async () => {
    await clearDb();
    const content = 'idempotent body';
    const id = await createResearch(content);
    const embedsAfterCreate = embedCalls.length;

    const res = await app.inject({
      method: 'PUT',
      url: `/research/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content },
    });
    expect(res.statusCode).toBe(200);
    expect(embedCalls.length).toBe(embedsAfterCreate);

    const audit = await app.inject({ method: 'GET', url: `/audit/${id}`, headers: auth });
    expect(audit.json().data.revisions).toHaveLength(1);
  });

  test('PUT scope mismatch and unknown id → 404; empty body → 400', async () => {
    await clearDb();
    const id = await createResearch('scoped body');

    const wrongScope = await app.inject({
      method: 'PUT',
      url: `/research/${id}?projectId=some-other-project`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'nope' },
    });
    expect(wrongScope.statusCode).toBe(404);

    const unknown = await app.inject({
      method: 'PUT',
      url: `/research/${randomUUID()}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'nope' },
    });
    expect(unknown.statusCode).toBe(404);

    const empty = await app.inject({
      method: 'PUT',
      url: `/research/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { actor: 'tester' },
    });
    expect(empty.statusCode).toBe(400);
  });

  test('long body → multiple ResearchChunk nodes; PUT replaces the chunk set; DELETE hard-deletes', async () => {
    await clearDb();
    const longBody = 'novel findings about zeppelin flight dynamics and airframe design. '.repeat(
      60,
    );
    const id = await createResearch(longBody);

    const chunks = await read((tx) => ResearchChunkRepository.listByResearch(tx, id));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.projectId === PROJECT)).toBe(true);
    const originalIds = new Set(chunks.map((c) => c.id));

    const replacement = 'entirely new zeppelin findings after the redesign. '.repeat(60);
    const put = await app.inject({
      method: 'PUT',
      url: `/research/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: replacement },
    });
    expect(put.statusCode).toBe(200);
    const rechunked = await read((tx) => ResearchChunkRepository.listByResearch(tx, id));
    expect(rechunked.length).toBeGreaterThan(1);
    expect(rechunked.some((c) => originalIds.has(c.id))).toBe(false);

    const del = await app.inject({ method: 'DELETE', url: `/research/${id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    const afterDelete = await read((tx) => ResearchChunkRepository.listByResearch(tx, id));
    expect(afterDelete).toHaveLength(0);
  });

  test('recall surfaces researchChunks only when includeResearch is set, never via includeKnowledge', async () => {
    await clearDb();
    const body = 'the moonbase reactor requires cryogenic argon coolant cycling. '.repeat(60);
    const id = await createResearch(body);

    const withResearch = await app.inject({
      method: 'GET',
      url: `/recall?q=${encodeURIComponent('moonbase reactor coolant')}&includeResearch=true&projectId=${PROJECT}`,
      headers: auth,
    });
    expect(withResearch.statusCode).toBe(200);
    const data = withResearch.json().data;
    expect(data.research?.some((r: { id: string }) => r.id === id)).toBe(true);
    expect(data.researchChunks?.length).toBeGreaterThan(0);
    expect(data.researchChunks.every((c: { researchId: string }) => c.researchId === id)).toBe(
      true,
    );

    // Knowledge-only recall must not leak research chunks (separate label + indexes).
    const knowledgeOnly = await app.inject({
      method: 'GET',
      url: `/recall?q=${encodeURIComponent('moonbase reactor coolant')}&includeKnowledge=true&projectId=${PROJECT}`,
      headers: auth,
    });
    expect(knowledgeOnly.statusCode).toBe(200);
    const kData = knowledgeOnly.json().data;
    expect(kData.researchChunks).toBeUndefined();
    expect(
      (kData.knowledgeChunks ?? []).some((c: { text: string }) => c.text.includes('moonbase')),
    ).toBe(false);
  });

  test('expired research is excluded from chunk recall by the parent-liveness guard', async () => {
    await clearDb();
    const body = 'quantum widget calibration procedure for the flux array. '.repeat(60);
    const id = await createResearch(body);

    // Expire the parent directly — chunks remain in the graph but must not recall.
    await txWrite(async (tx) => {
      await tx.run(`MATCH (r:Research {id: $id}) SET r.expiresAt = datetime() - duration('PT1H')`, {
        id,
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: `/recall?q=${encodeURIComponent('quantum widget calibration')}&includeResearch=true&projectId=${PROJECT}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.researchChunks ?? []).toHaveLength(0);
  });

  test('pre-retention rows without content still deserialize (content absent)', async () => {
    await clearDb();
    const id = randomUUID();
    // Simulate a row created before content retention: no `content` property.
    await txWrite(async (tx) => {
      await tx.run(
        `CREATE (r:Research:MemoryItem {
           id: $id, kind: 'research', title: 'legacy', source: 'manual',
           contentHash: 'deadbeef', summary: 'legacy summary', embedding: [],
           tags: [], projectId: $projectId,
           createdAt: datetime(), updatedAt: datetime()
         })`,
        { id, projectId: PROJECT },
      );
    });

    const res = await app.inject({ method: 'GET', url: `/research/${id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.content).toBeUndefined();
    expect(data.summary).toBe('legacy summary');
  });
});
