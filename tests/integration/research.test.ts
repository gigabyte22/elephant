// Integration test for research body retention: the full content posted to
// /research must be persisted on the node and returned by the read paths,
// alongside the sha256 contentHash the service already computed.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

beforeAll(async () => {
  const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
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
