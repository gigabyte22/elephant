// GET /entities/:id and GET /timeline used to list facts with no scope filter
// at all, so any caller could read another project's facts through a shared
// entity name (or the whole graph, on a timeline without entityId). Entities
// stay global (they merge by name across scopes); the caller's scope narrows
// the facts the same way the list routes do.

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

async function saveFact(content: string, scope: { projectId?: string; userId?: string }) {
  const res = await app.inject({
    method: 'POST',
    url: '/facts',
    headers: json,
    payload: { content, entityNames: ['Kestrel'], ...scope },
  });
  expect(res.statusCode).toBe(200);
}

async function seed(): Promise<string> {
  await saveFact('Kestrel ships on Fridays for project alpha', { projectId: 'alpha' });
  await saveFact('Kestrel is frozen in project beta until audit', { projectId: 'beta' });
  await saveFact('Kestrel is the deploy pipeline name', {});
  await saveFact('Kestrel belongs to user u1 in alpha', { projectId: 'alpha', userId: 'u1' });
  await saveFact('Kestrel belongs to user u2 in alpha', { projectId: 'alpha', userId: 'u2' });
  const res = await app.inject({ method: 'GET', url: '/entities?name=Kestrel', headers: auth });
  const entities = res.json().data.entities as Array<{ id: string }>;
  expect(entities).toHaveLength(1);
  return entities[0]!.id;
}

async function factContents(url: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url, headers: auth });
  expect(res.statusCode).toBe(200);
  return (res.json().data.facts as Array<{ content: string }>).map((f) => f.content).sort();
}

describe('GET /entities/:id scope', () => {
  test('no scope declared returns every linked fact', async () => {
    const id = await seed();
    expect(await factContents(`/entities/${id}`)).toHaveLength(5);
  });

  test('projectId keeps in-scope and shared facts and drops other projects', async () => {
    const id = await seed();
    expect(await factContents(`/entities/${id}?projectId=alpha`)).toEqual([
      'Kestrel belongs to user u1 in alpha',
      'Kestrel belongs to user u2 in alpha',
      'Kestrel is the deploy pipeline name',
      'Kestrel ships on Fridays for project alpha',
    ]);
  });

  test('userId narrows the second axis', async () => {
    const id = await seed();
    expect(await factContents(`/entities/${id}?projectId=alpha&userId=u1`)).toEqual([
      'Kestrel belongs to user u1 in alpha',
      'Kestrel is the deploy pipeline name',
      'Kestrel ships on Fridays for project alpha',
    ]);
  });

  test('explicit modes: strict drops shared facts, shared keeps only them', async () => {
    const id = await seed();
    expect(await factContents(`/entities/${id}?projectId=beta&projectScope=strict`)).toEqual([
      'Kestrel is frozen in project beta until audit',
    ]);
    expect(await factContents(`/entities/${id}?projectScope=shared`)).toEqual([
      'Kestrel is the deploy pipeline name',
    ]);
  });

  test('the entity itself is returned to every scope', async () => {
    const id = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/entities/${id}?projectId=gamma&projectScope=strict`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.entity.id).toBe(id);
    expect(res.json().data.facts).toEqual([]);
  });
});

describe('GET /timeline scope', () => {
  const at = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());

  test('no scope declared returns every fact, with or without entityId', async () => {
    const id = await seed();
    expect(await factContents(`/timeline?at=${at}&entityId=${id}`)).toHaveLength(5);
    expect(await factContents(`/timeline?at=${at}`)).toHaveLength(5);
  });

  test('projectId keeps in-scope and shared facts and drops other projects', async () => {
    const id = await seed();
    const expected = [
      'Kestrel belongs to user u1 in alpha',
      'Kestrel belongs to user u2 in alpha',
      'Kestrel is the deploy pipeline name',
      'Kestrel ships on Fridays for project alpha',
    ];
    expect(await factContents(`/timeline?at=${at}&entityId=${id}&projectId=alpha`)).toEqual(
      expected,
    );
    expect(await factContents(`/timeline?at=${at}&projectId=alpha`)).toEqual(expected);
  });

  test('userId and explicit modes apply as on the entity route', async () => {
    const id = await seed();
    expect(
      await factContents(`/timeline?at=${at}&entityId=${id}&projectId=alpha&userId=u2`),
    ).toEqual([
      'Kestrel belongs to user u2 in alpha',
      'Kestrel is the deploy pipeline name',
      'Kestrel ships on Fridays for project alpha',
    ]);
    expect(await factContents(`/timeline?at=${at}&projectScope=shared`)).toEqual([
      'Kestrel is the deploy pipeline name',
    ]);
    expect(await factContents(`/timeline?at=${at}&projectId=beta&projectScope=strict`)).toEqual([
      'Kestrel is frozen in project beta until audit',
    ]);
  });
});
