// Cross-scope mutation by id.
//
// Auth is a single shared bearer token, so scope is the only thing separating
// one orchestrator's memory from another's — and it was applied inconsistently
// on the write paths. GET and PUT /research/:id guarded; DELETE /research/:id
// did not. Procedure PUT/DELETE and every knowledge mutation had no guard at
// all. Any caller holding the token could delete or overwrite another
// project's memory by id.
//
// Facts were the last gap, and the widest: unlike the others, a fact id is often
// DERIVED from its content and scope rather than handed out, so an id is not
// evidence the caller was ever shown the fact.

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

// `userId` seeds the second axis: the leg that the old projectId-only
// querystring on GET/PUT /research/:id silently dropped.
async function createResearch(userId?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/research',
    headers: json,
    payload: {
      title: 'Owned',
      source: 'manual',
      content: 'body',
      projectId: OWNER,
      ...(userId ? { userId } : {}),
    },
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

// An intention needs one of dueAt/triggerHint/schedule to be accepted at all;
// triggerHint is the cheapest, and the scope guard ignores it.
async function createIntention(projectId?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/intentions',
    headers: json,
    payload: {
      content: 'ship the release notes',
      triggerHint: 'next deploy',
      ...(projectId ? { scope: { projectId } } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

type Response = Awaited<ReturnType<typeof app.inject>>;

// The id-addressed reads guarded alongside the mutations. `query` carries the
// caller's declared scope, including the empty string for a caller declaring none.
function get(url: string, query = ''): Promise<Response> {
  return app.inject({ method: 'GET', url: `${url}${query}`, headers: auth });
}

async function createFact(scope?: { projectId?: string; userId?: string }): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/facts',
    headers: json,
    payload: { content: 'postgres runs on port 5432', ...scope },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

// The three guarded fact routes; `query` works as on `get` above.
function getFact(id: string, query = ''): Promise<Response> {
  return app.inject({ method: 'GET', url: `/facts/${id}${query}`, headers: auth });
}

function deleteFact(id: string, query = ''): Promise<Response> {
  return app.inject({ method: 'DELETE', url: `/facts/${id}${query}`, headers: auth });
}

function supersedeFact(
  oldId: string,
  newId: string,
  query = '',
  reason = 'moved',
): Promise<Response> {
  return app.inject({
    method: 'POST',
    url: `/facts/${oldId}/supersede${query}`,
    headers: json,
    payload: { newFactId: newId, reason },
  });
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

  // GET/PUT took an inline projectId-only querystring, so a declared userId was
  // silently dropped and never enforced.
  test('GET with a mismatched userId is refused', async () => {
    const id = await createResearch('usr-owner');
    const url = `/research/${id}?projectId=${OWNER}`;
    expect((await get(url, '&userId=usr-intruder')).statusCode).toBe(404);
    expect((await get(url, '&userId=usr-owner')).statusCode).toBe(200);
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

  // GET was the outlier: PUT and DELETE guarded, the read did not, and the
  // route declared no querystring so a caller could not even offer a scope.
  test('GET from another project is refused, and from the owning one is not', async () => {
    const id = await createProcedure(OWNER);
    expect((await get(`/procedures/${id}`, `?projectId=${INTRUDER}`)).statusCode).toBe(404);
    expect((await get(`/procedures/${id}`, `?projectId=${OWNER}`)).statusCode).toBe(200);
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

  test('GET from another project is refused, and from the owning one is not', async () => {
    const id = await createDocument(OWNER);
    const url = `/knowledge/documents/${id}`;
    expect((await get(url, `?projectId=${INTRUDER}`)).statusCode).toBe(404);
    expect((await get(url, `?projectId=${OWNER}`)).statusCode).toBe(200);
  });

  // Same guard on the dashboard surface, which delegates to the same unguarded
  // service call and so had the same hole.
  test('the dashboard markdown view is guarded too', async () => {
    const id = await createDocument(OWNER);
    const url = `/dashboard/api/knowledge/documents/${id}/markdown`;
    expect((await get(url, `?projectId=${INTRUDER}`)).statusCode).toBe(404);
    expect((await get(url, `?projectId=${OWNER}`)).statusCode).toBe(200);
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

describe('intentions', () => {
  test('GET from another project is refused, and from the owning one is not', async () => {
    const id = await createIntention(OWNER);
    expect((await get(`/intentions/${id}`, `?projectId=${INTRUDER}`)).statusCode).toBe(404);
    expect((await get(`/intentions/${id}`, `?projectId=${OWNER}`)).statusCode).toBe(200);
  });
});

describe('facts', () => {
  const asOwner = `?projectId=${OWNER}`;
  const asIntruder = `?projectId=${INTRUDER}`;

  test('GET from another project is refused, and from the owning one is not', async () => {
    const id = await createFact({ projectId: OWNER });
    expect((await getFact(id, asIntruder)).statusCode).toBe(404);

    const mine = await getFact(id, asOwner);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data.id).toBe(id);
    expect(mine.json().data.projectId).toBe(OWNER);
  });

  test('DELETE from another project is refused and the fact is untouched', async () => {
    const id = await createFact({ projectId: OWNER });
    expect((await deleteFact(id, asIntruder)).statusCode).toBe(404);

    const still = await getFact(id, asOwner);
    expect(still.statusCode).toBe(200);
    expect(still.json().data.validTo).toBeNull();
  });

  test('supersede from another project is refused and leaves validTo open', async () => {
    const oldId = await createFact({ projectId: OWNER });
    const newId = await createFact({ projectId: OWNER });

    expect((await supersedeFact(oldId, newId, asIntruder, 'hijack')).statusCode).toBe(404);
    expect((await getFact(oldId, asOwner)).json().data.validTo).toBeNull();
  });

  // Supersede writes to the NEW fact too (supersedesFactId, plus the SUPERSEDES
  // edge), so both sides are guarded. Guarding only the old fact would let a
  // caller stamp another project's node with its own, and read the id's
  // existence off the 200/404 split.
  test('supersede is refused when the new fact is out of scope', async () => {
    const mine = await createFact({ projectId: INTRUDER });
    const theirs = await createFact({ projectId: OWNER });

    expect((await supersedeFact(mine, theirs, asIntruder, 'hijack')).statusCode).toBe(404);
    expect((await getFact(theirs, asOwner)).json().data.supersedes).toBeUndefined();
    expect((await getFact(mine, asIntruder)).json().data.validTo).toBeNull();
  });

  test('the owning project can still supersede and delete', async () => {
    const oldId = await createFact({ projectId: OWNER });
    const newId = await createFact({ projectId: OWNER });

    expect((await supersedeFact(oldId, newId, asOwner)).statusCode).toBe(200);
    expect((await deleteFact(newId, asOwner)).statusCode).toBe(200);
  });

  // The userId axis is guarded the same way, and nothing else in this file
  // exercises it.
  test('the userId axis is guarded too', async () => {
    const id = await createFact({ userId: 'user:alice' });
    expect((await getFact(id, '?userId=user:bob')).statusCode).toBe(404);
    expect((await getFact(id, '?userId=user:alice')).statusCode).toBe(200);
  });

  // A missing id and a cross-scope id must be indistinguishable, or the status
  // code becomes an existence oracle for ids the caller cannot see. Supersede
  // is the one to pin: the service reports a missing old fact as a 400.
  test('an unknown id 404s exactly like a cross-scope one', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await getFact(unknown, asOwner)).statusCode).toBe(404);
    expect((await supersedeFact(unknown, unknown, asOwner)).statusCode).toBe(404);
  });

  // Redaction is retroactive on every read path, so the new GET must not become
  // the one surface that resurrects a deleted fact. Supersession is history, not
  // redaction, so a superseded fact still reads.
  test('GET hides a redacted fact but still returns a superseded one', async () => {
    const oldId = await createFact({ projectId: OWNER });
    const newId = await createFact({ projectId: OWNER });
    await supersedeFact(oldId, newId, asOwner);

    const superseded = await getFact(oldId, asOwner);
    expect(superseded.statusCode).toBe(200);
    expect(superseded.json().data.validTo).not.toBeNull();

    await deleteFact(newId, asOwner);
    expect((await getFact(newId, asOwner)).statusCode).toBe(404);
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

  // One test, every read the guard now covers: the statement is about the guard,
  // not the route. Closing the cross-scope hole must not narrow the
  // single-tenant default on any of them.
  test('a caller declaring no scope can still read every scope-guarded id route', async () => {
    const docId = await createDocument(OWNER);
    const procId = await createProcedure(OWNER);
    const intentionId = await createIntention(OWNER);
    const researchId = await createResearch();
    const markdown = `/dashboard/api/knowledge/documents/${docId}/markdown`;

    expect((await get(`/knowledge/documents/${docId}`)).statusCode).toBe(200);
    expect((await get(`/procedures/${procId}`)).statusCode).toBe(200);
    expect((await get(`/intentions/${intentionId}`)).statusCode).toBe(200);
    expect((await get(`/research/${researchId}`)).statusCode).toBe(200);
    expect((await get(markdown)).statusCode).toBe(200);
  });

  // Both rules again on facts, because that is where dobby's Commons tier lives:
  // its shared rows are NULL on both axes and must stay reachable from every
  // scope, while its existing single-tenant callers send no scope at all.
  test('an unscoped fact stays deletable by a scoped caller', async () => {
    const id = await createFact();
    expect((await deleteFact(id, `?projectId=${INTRUDER}`)).statusCode).toBe(200);
  });

  test('a caller declaring no scope can still reach a scoped fact', async () => {
    const id = await createFact({ projectId: OWNER });
    expect((await getFact(id)).statusCode).toBe(200);
    expect((await deleteFact(id)).statusCode).toBe(200);
  });
});
