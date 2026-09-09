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

// Sorted, so the assertions don't depend on Neo4j's row order — the expected
// lists are sorted the same way.
async function listTitles(query: string): Promise<string[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/knowledge/documents${query}`,
    headers: auth,
  });
  expect(res.statusCode).toBe(200);
  return (res.json().data as Array<{ title: string }>).map((d) => d.title).sort();
}

beforeEach(async () => {
  assertDestructiveAllowed();
  await write(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
  await createDocument(ALICE_NOTE, ALICE);
  await createDocument(BOB_NOTE, BOB);
  await createDocument(SHARED_NOTE);
});

describe('listing knowledge across scopes', () => {
  // The baseline the other cases are read against.
  test('omitting the axis returns every account, by design', async () => {
    expect(await listTitles('')).toEqual([SHARED_NOTE, ALICE_NOTE, BOB_NOTE].sort());
  });

  test('naming an account returns that account plus the shared items', async () => {
    expect(await listTitles(`?projectId=${ALICE}`)).toEqual([SHARED_NOTE, ALICE_NOTE].sort());
  });

  // The gap. A shared-space listing wants the third row and only the third row.
  test("'shared' returns the shared items and nothing else", async () => {
    expect(await listTitles('?projectScope=shared')).toEqual([SHARED_NOTE]);
  });

  // The failure this exists to prevent, stated as its own assertion: whatever a
  // shared-space listing sends, it must never contain another account's items.
  test('a shared listing never contains an account-scoped item', async () => {
    const titles = await listTitles('?projectScope=shared');
    expect(titles).not.toContain(ALICE_NOTE);
    expect(titles).not.toContain(BOB_NOTE);
  });
});
