// Listing only the SHARED (null-scoped) memory items.
//
// A null scope value means "shared with everyone", and the scope modes could
// describe every relationship to that except the one a shared-space listing
// needs: 'filter' is mine-plus-shared, 'strict' is mine-only, 'none' ignores
// the axis and 'boost' only reranks. So a caller asking for *just* the shared
// items had to omit the axis, which selects 'none' and returns every scope's
// items instead. A consumer with per-account scopes (personal:a, personal:b)
// rendering a shared space that way shows each account the other's private
// documents.
//
// These specs seed two accounts plus a shared document and pin what each mode
// returns, so the distinction can't quietly regress.

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

const ALICE = 'personal:usr_alice';
const BOB = 'personal:usr_bob';

const ALICE_NOTE = "Alice's private note";
const BOB_NOTE = "Bob's private note";
const SHARED_NOTE = 'A shared note';

// Research always carries a projectId (POST /research requires it), so its
// shared space lives on the nullable USER axis instead.
const RESEARCH_PROJECT = 'proj-research';
const ALICE_USER = 'usr_alice';
const BOB_USER = 'usr_bob';

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

// Omitting the projectId is what "everyone can read this" looks like in
// storage. Note the scope is nested: a stray top-level projectId is silently
// stripped by the body schema and would seed an unscoped document instead.
async function createDocument(title: string, projectId?: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/knowledge/documents',
    headers: json,
    payload: {
      title,
      source: 'seed',
      content: `body of ${title}`,
      ...(projectId ? { scope: { projectId } } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
}

// Nested scope again, on procedures and intentions both: same trap as
// createDocument, where a stray top-level projectId would be stripped and seed
// an unscoped row, making a leak test pass while proving nothing.
async function createProcedure(name: string, projectId?: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/procedures',
    headers: json,
    payload: {
      name,
      content: `body of ${name}`,
      whenToUse: `when ${name}`,
      ...(projectId ? { scope: { projectId } } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
}

// An intention needs one of dueAt/triggerHint/schedule to be accepted at all,
// and dueAt in the past lets the same rows serve the /intentions/due case.
async function createIntention(content: string, projectId?: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/intentions',
    headers: json,
    payload: {
      content,
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      ...(projectId ? { scope: { projectId } } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
}

// Research takes its scope top-level, unlike the three above.
async function createResearch(title: string, userId?: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/research',
    headers: json,
    payload: {
      title,
      source: 'seed',
      content: `body of ${title}`,
      projectId: RESEARCH_PROJECT,
      ...(userId ? { userId } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
}

// Sorted, so the assertions don't depend on Neo4j's row order — the expected
// lists are sorted the same way. `field` differs per category: documents and
// research are titled, procedures are named, intentions carry content.
async function listLabels(path: string, query: string, field = 'title'): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: `${path}${query}`, headers: auth });
  expect(res.statusCode).toBe(200);
  const rows = res.json().data as Array<Record<string, string | undefined>>;
  return rows
    .map((row) => {
      const label = row[field];
      // A row missing its label means the route changed shape. Throw rather than
      // sort a list of undefineds, which would quietly satisfy a not.toContain.
      if (label === undefined) throw new Error(`row has no ${field}: ${JSON.stringify(row)}`);
      return label;
    })
    .sort();
}

beforeEach(async () => {
  assertDestructiveAllowed();
  await write(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
  await createDocument(ALICE_NOTE, ALICE);
  await createDocument(BOB_NOTE, BOB);
  await createDocument(SHARED_NOTE);
  await createProcedure(ALICE_NOTE, ALICE);
  await createProcedure(BOB_NOTE, BOB);
  await createProcedure(SHARED_NOTE);
  await createIntention(ALICE_NOTE, ALICE);
  await createIntention(BOB_NOTE, BOB);
  await createIntention(SHARED_NOTE);
  await createResearch(ALICE_NOTE, ALICE_USER);
  await createResearch(BOB_NOTE, BOB_USER);
  await createResearch(SHARED_NOTE);
});

describe('listing knowledge across scopes', () => {
  const titles = (query: string) => listLabels('/knowledge/documents', query);

  // The baseline the other cases are read against.
  test('omitting the axis returns every account, by design', async () => {
    expect(await titles('')).toEqual([SHARED_NOTE, ALICE_NOTE, BOB_NOTE].sort());
  });

  test('naming an account returns that account plus the shared items', async () => {
    expect(await titles(`?projectId=${ALICE}`)).toEqual([SHARED_NOTE, ALICE_NOTE].sort());
  });

  // The gap. A shared-space listing wants the third row and only the third row.
  test("'shared' returns the shared items and nothing else", async () => {
    expect(await titles('?projectScope=shared')).toEqual([SHARED_NOTE]);
  });

  // The failure this exists to prevent, stated as its own assertion: whatever a
  // shared-space listing sends, it must never contain another account's items.
  test('a shared listing never contains an account-scoped item', async () => {
    const found = await titles('?projectScope=shared');
    expect(found).not.toContain(ALICE_NOTE);
    expect(found).not.toContain(BOB_NOTE);
  });
});

// The same four questions on the routes that could not ask them until now. #93
// exposed the modes on knowledge alone; procedures and intentions inferred the
// mode from id presence, so 'shared' was unreachable.
describe('listing procedures across scopes', () => {
  const names = (query: string) => listLabels('/procedures', query, 'name');

  test('omitting the axis returns every account, by design', async () => {
    expect(await names('')).toEqual([SHARED_NOTE, ALICE_NOTE, BOB_NOTE].sort());
  });

  test('naming an account returns that account plus the shared items', async () => {
    expect(await names(`?projectId=${ALICE}`)).toEqual([SHARED_NOTE, ALICE_NOTE].sort());
  });

  test("'shared' returns the shared items and nothing else", async () => {
    expect(await names('?projectScope=shared')).toEqual([SHARED_NOTE]);
  });

  test('a shared listing never contains an account-scoped item', async () => {
    const found = await names('?projectScope=shared');
    expect(found).not.toContain(ALICE_NOTE);
    expect(found).not.toContain(BOB_NOTE);
  });

  // The ?name= branch bypasses the list query entirely, so it needs its own
  // pinning: it resolves an exact name and must honour the mode the same way.
  test('the name lookup honours the shared mode too', async () => {
    expect(await names(`?name=${encodeURIComponent(SHARED_NOTE)}&projectScope=shared`)).toEqual([
      SHARED_NOTE,
    ]);
    expect(await names(`?name=${encodeURIComponent(ALICE_NOTE)}&projectScope=shared`)).toEqual([]);
  });
});

describe('listing intentions across scopes', () => {
  const contents = (query: string) => listLabels('/intentions', query, 'content');

  test('omitting the axis returns every account, by design', async () => {
    expect(await contents('')).toEqual([SHARED_NOTE, ALICE_NOTE, BOB_NOTE].sort());
  });

  test('naming an account returns that account plus the shared items', async () => {
    expect(await contents(`?projectId=${ALICE}`)).toEqual([SHARED_NOTE, ALICE_NOTE].sort());
  });

  test("'shared' returns the shared items and nothing else", async () => {
    expect(await contents('?projectScope=shared')).toEqual([SHARED_NOTE]);
  });

  test('a shared listing never contains an account-scoped item', async () => {
    const found = await contents('?projectScope=shared');
    expect(found).not.toContain(ALICE_NOTE);
    expect(found).not.toContain(BOB_NOTE);
  });

  // /intentions/due shares the same builder, so the mode must reach it as well.
  test("'shared' applies to /intentions/due too", async () => {
    expect(await listLabels('/intentions/due', '?projectScope=shared', 'content')).toEqual([
      SHARED_NOTE,
    ]);
  });

  // Exercises the generalized builder on a second axis: every intention here is
  // seeded without a userId, so a shared user listing is all three.
  test('the user axis takes a mode independently', async () => {
    expect(await contents('?userScope=shared')).toEqual([SHARED_NOTE, ALICE_NOTE, BOB_NOTE].sort());
  });
});

describe('listing research across scopes', () => {
  const titles = (query: string) => listLabels('/research', query);

  // The axis is no longer mandatory, but omitting it entirely still has to be
  // refused: that would select 'none', which spans every project.
  test('projectId is required unless a mode is supplied', async () => {
    const res = await app.inject({ method: 'GET', url: '/research', headers: auth });
    expect(res.statusCode).toBe(400);
  });

  test('naming the project returns its rows', async () => {
    expect(await titles(`?projectId=${RESEARCH_PROJECT}`)).toEqual(
      [SHARED_NOTE, ALICE_NOTE, BOB_NOTE].sort(),
    );
  });

  // projectScope=shared is empty here, and the assertion that matters is WHY:
  // POST /research refuses a body with no projectId, so no null-scoped research
  // row can exist. An empty list alone would also be what a broken filter
  // returns; this pins the construction, not the symptom. The live proof that
  // 'shared' works on research is the userScope case below, where the axis IS
  // nullable.
  test("'shared' on the project axis is empty, and empty by construction", async () => {
    const rejected = await app.inject({
      method: 'POST',
      url: '/research',
      headers: json,
      payload: { title: 'Unscoped', source: 'seed', content: 'body' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(await titles('?projectScope=shared')).toEqual([]);
  });

  test("'shared' on the user axis returns the rows carrying no user", async () => {
    expect(await titles(`?projectId=${RESEARCH_PROJECT}&userScope=shared`)).toEqual([SHARED_NOTE]);
  });

  test('a shared user listing never contains a user-scoped row', async () => {
    const found = await titles(`?projectId=${RESEARCH_PROJECT}&userScope=shared`);
    expect(found).not.toContain(ALICE_NOTE);
    expect(found).not.toContain(BOB_NOTE);
  });
});
