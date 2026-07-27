// Cross-scope mutation by id.
//
// Auth is a single shared bearer token, so scope is the only thing separating
// one orchestrator's memory from another's — and it was applied inconsistently
// on the write paths. GET and PUT /research/:id guarded; DELETE /research/:id
// did not. Procedure PUT/DELETE and every knowledge mutation had no guard at
// all. Any caller holding the token could delete or overwrite another
// project's memory by id.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { write } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };

const OWNER = 'proj-owner';
const INTRUDER = 'proj-intruder';

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

async function createResearch(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/research',
    headers: json,
    payload: { title: 'Owned', source: 'manual', content: 'body', projectId: OWNER },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

async function createProcedure(projectId?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/procedures',
    headers: json,
    payload: {
      name: 'rollback',
      content: 'step 1',
      whenToUse: 'bad release',
      ...(projectId ? { scope: { projectId } } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

async function createDocument(projectId?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/knowledge/documents',
    headers: json,
    payload: {
      title: 'Runbook',
      source: 'wiki',
      content: 'body',
      ...(projectId ? { scope: { projectId } } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

describe('research', () => {
  test('DELETE from another project is refused', async () => {
    const id = await createResearch();
    const res = await app.inject({
      method: 'DELETE',
      url: `/research/${id}?projectId=${INTRUDER}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);

    // …and the record is untouched.
    const still = await app.inject({
      method: 'GET',
      url: `/research/${id}?projectId=${OWNER}`,
      headers: auth,
    });
    expect(still.statusCode).toBe(200);
    expect(still.json().data.expiresAt).toBeNull();
  });

  test('DELETE from the owning project still works', async () => {
    const id = await createResearch();
    const res = await app.inject({
      method: 'DELETE',
      url: `/research/${id}?projectId=${OWNER}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('procedures', () => {
  test('PUT from another project is refused and changes nothing', async () => {
    const id = await createProcedure(OWNER);
    const res = await app.inject({
      method: 'PUT',
      url: `/procedures/${id}?projectId=${INTRUDER}`,
      headers: json,
      payload: { content: 'malicious rewrite' },
    });
    expect(res.statusCode).toBe(404);

    const got = await app.inject({ method: 'GET', url: `/procedures/${id}`, headers: auth });
    expect(got.json().data.content).toBe('step 1');
  });

  test('DELETE from another project is refused', async () => {
    const id = await createProcedure(OWNER);
    const res = await app.inject({
      method: 'DELETE',
      url: `/procedures/${id}?projectId=${INTRUDER}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  test('the owning project can still mutate', async () => {
    const id = await createProcedure(OWNER);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/procedures/${id}?projectId=${OWNER}`,
          headers: json,
          payload: { content: 'step 2' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/procedures/${id}?projectId=${OWNER}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('knowledge documents', () => {
  test('PUT and DELETE from another project are refused', async () => {
    const id = await createDocument(OWNER);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/knowledge/documents/${id}?projectId=${INTRUDER}`,
          headers: json,
          payload: { title: 'hijacked' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/knowledge/documents/${id}?projectId=${INTRUDER}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);

    const got = await app.inject({
      method: 'GET',
      url: `/knowledge/documents/${id}`,
      headers: auth,
    });
    expect(got.json().data.title).toBe('Runbook');
  });

  test('attachment upload from another project is refused', async () => {
    const id = await createDocument(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/knowledge/documents/${id}/attachments?projectId=${INTRUDER}`,
      headers: json,
      payload: {
        filename: 'x.txt',
        mimeType: 'text/plain',
        dataBase64: Buffer.from('hello').toString('base64'),
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('semantics', () => {
  // Matches `filter`, not `strict`: an unscoped item is a shared global.
  test('an unscoped item stays mutable by a scoped caller', async () => {
    const id = await createProcedure();
    const res = await app.inject({
      method: 'PUT',
      url: `/procedures/${id}?projectId=${INTRUDER}`,
      headers: json,
      payload: { content: 'step 2' },
    });
    expect(res.statusCode).toBe(200);
  });

  // Keeps the single-tenant default working: a caller that declares no scope
  // is unrestricted. Real isolation needs per-key scope binding at the auth
  // layer; this closes the gap where a caller that DOES declare its scope
  // could still reach outside it.
  test('a caller declaring no scope is unrestricted', async () => {
    const id = await createProcedure(OWNER);
    const res = await app.inject({
      method: 'DELETE',
      url: `/procedures/${id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
  });
});
