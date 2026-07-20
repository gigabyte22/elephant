// Knowledge revision parity: PUT /knowledge/documents/:id must snapshot the
// pre-update state into an :ArchivedRevision via revise(), matching the
// procedure and research update contracts (SPEC audit/revision section).

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

async function createDoc(content: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/knowledge/documents',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { title: 'Runbook', source: 'manual', content },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

interface AuditData {
  revisions: Array<{ snapshot: Record<string, unknown>; reason: string }>;
  events: Array<{ kind: string; payload: Record<string, unknown> }>;
}

async function auditFor(id: string): Promise<AuditData> {
  const res = await app.inject({ method: 'GET', url: `/audit/${id}`, headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json().data as AuditData;
}

describe('knowledge document revision snapshots', () => {
  test('PUT with new content → revision snapshots the OLD content sans embedding', async () => {
    await clearDb();
    const original = 'original knowledge body';
    const id = await createDoc(original);

    const put = await app.inject({
      method: 'PUT',
      url: `/knowledge/documents/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: 'replacement knowledge body', reason: 'doc refresh' },
    });
    expect(put.statusCode).toBe(200);

    const { revisions, events } = await auditFor(id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.snapshot.content).toBe(original);
    expect(revisions[0]!.snapshot).not.toHaveProperty('embedding');
    expect(revisions[0]!.reason).toBe('doc refresh');
    expect(events.filter((e) => e.kind === 'update')).toHaveLength(1);
  });

  test('title-only PUT → revision still recorded (unconditional, like procedures/research)', async () => {
    await clearDb();
    const id = await createDoc('stable body');

    const put = await app.inject({
      method: 'PUT',
      url: `/knowledge/documents/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'renamed runbook' },
    });
    expect(put.statusCode).toBe(200);

    const { revisions, events } = await auditFor(id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.snapshot.title).toBe('Runbook');
    const update = events.find((e) => e.kind === 'update');
    expect(update?.payload.changes).toEqual(['title']);
    expect(update?.payload.contentChanged).toBe(false);
  });

  test('DELETE stays record()-only: no additional revision', async () => {
    await clearDb();
    const id = await createDoc('doomed body');

    const del = await app.inject({
      method: 'DELETE',
      url: `/knowledge/documents/${id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);

    const { revisions, events } = await auditFor(id);
    expect(revisions).toHaveLength(0);
    expect(events.map((e) => e.kind)).toContain('soft_delete');
  });
});
