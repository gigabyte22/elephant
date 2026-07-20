// The documents ledger + narrative search — the discovery surface for
// research and knowledge documents. The load-bearing assertions here are the
// exclusions: both kinds implement soft-delete as `expiresAt = now`, so a
// missing liveness predicate silently resurrects deleted documents in the
// index and in search.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' } as const;
const PROJECT = 'docs-proj';

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

beforeAll(async () => {
  container = await bootstrap({
    llm: createFakeLLMAdapter(),
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

async function createResearch(title: string, content: string, projectId = PROJECT) {
  const res = await app.inject({
    method: 'POST',
    url: '/research',
    headers: json,
    payload: { title, source: 'manual', content, projectId },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

async function createDoc(title: string, content: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/knowledge/documents',
    headers: json,
    payload: { title, source: 'wiki', content },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

function listDocs(query = '') {
  return app.inject({ method: 'GET', url: `/dashboard/api/documents${query}`, headers: auth });
}

describe('documents ledger', () => {
  test('lists both narrative kinds with scope, kind and text filters', async () => {
    await clearDb();
    await createResearch('Latency investigation', 'p99 regressed after the retry change');
    await createDoc('Deployment Runbook', 'how to deploy and roll back');

    const all = await listDocs();
    expect(all.statusCode).toBe(200);
    expect(all.json().data.total).toBe(2);
    expect(
      all
        .json()
        .data.items.map((d: { kind: string }) => d.kind)
        .sort(),
    ).toEqual(['knowledge_document', 'research']);

    const onlyResearch = await listDocs('?kind=research');
    expect(onlyResearch.json().data.total).toBe(1);
    expect(onlyResearch.json().data.items[0].title).toBe('Latency investigation');

    // q matches title or summary, case-insensitively.
    const byText = await listDocs('?q=runbook');
    expect(byText.json().data.total).toBe(1);
    expect(byText.json().data.items[0].kind).toBe('knowledge_document');

    // Knowledge docs created without a project are unscoped, so a project
    // filter should return only the research row.
    const scoped = await listDocs(`?projectId=${PROJECT}`);
    expect(scoped.json().data.total).toBe(1);
    expect(scoped.json().data.items[0].kind).toBe('research');
  });

  test('excludes lapsed research and soft-deleted documents', async () => {
    await clearDb();
    const liveId = await createResearch('Live research', 'still current');
    const lapsedId = await createResearch('Lapsed research', 'expired an hour ago');
    const docId = await createDoc('Doomed Runbook', 'about to be deleted');

    await txWrite(async (tx) => {
      await tx.run(`MATCH (r:Research {id: $id}) SET r.expiresAt = datetime() - duration('PT1H')`, {
        id: lapsedId,
      });
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/knowledge/documents/${docId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);

    const listed = await listDocs();
    const ids = listed.json().data.items.map((d: { id: string }) => d.id);
    expect(ids).toEqual([liveId]);
    expect(listed.json().data.total).toBe(1);
  });

  test('flags pre-retention rows so a stub is distinguishable from a document', async () => {
    await clearDb();
    const id = await createResearch('Has a body', 'a real body');
    // Simulate a pre-retention row: the node predates content retention.
    await txWrite(async (tx) => {
      await tx.run('MATCH (r:Research {id: $id}) REMOVE r.content', { id });
    });

    const listed = await listDocs();
    expect(listed.json().data.items[0].hasContent).toBe(false);
  });
});

describe('narrative search', () => {
  test('research and knowledge documents are first-class search hits', async () => {
    await clearDb();
    await createResearch('Latency investigation', 'p99 regressed after the retry change');
    await createDoc('Deployment Runbook', 'how to deploy and roll back');

    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/graph/search?q=deployment',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const kinds = res.json().data.results.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain('knowledge_document');

    const research = await app.inject({
      method: 'GET',
      url: '/dashboard/api/graph/search?q=latency',
      headers: auth,
    });
    const hit = research.json().data.results.find((r: { kind: string }) => r.kind === 'research') as
      | { label: string }
      | undefined;
    // The label is the title, not a truncation of the body — these two kinds
    // bypass runFulltextSearch precisely for that.
    expect(hit?.label).toBe('Latency investigation');
  });

  test('lapsed research never surfaces in search', async () => {
    await clearDb();
    const id = await createResearch('Latency investigation', 'p99 regressed');
    await txWrite(async (tx) => {
      await tx.run(`MATCH (r:Research {id: $id}) SET r.expiresAt = datetime() - duration('PT1H')`, {
        id,
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/api/graph/search?q=latency',
      headers: auth,
    });
    const kinds = res.json().data.results.map((r: { kind: string }) => r.kind);
    expect(kinds).not.toContain('research');
  });
});
