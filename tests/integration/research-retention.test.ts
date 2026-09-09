// Integration test for research retention: the purge sweep and the id-lookup
// liveness guard.
//
// The purge is the first automatic hard delete of a :MemoryItem in the service,
// so what it takes with it — and what it deliberately leaves — is the contract
// worth pinning. A purge that removes the node but strands its chunks or its
// :ArchivedRevision snapshots would leak the very body it exists to release,
// because serialiseForSnapshot strips only `embedding`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { ResearchRepository } from '../../src/repositories/ResearchRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const PROJECT = 'proj-research-retention';

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

async function createResearch(content: string, expiresAt?: Date): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/research',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: {
      title: `retention fixture ${randomUUID()}`,
      source: 'manual',
      content,
      projectId: PROJECT,
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);
const daysAhead = (n: number): Date => new Date(Date.now() + n * 86_400_000);

async function countNodes(label: string): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(`MATCH (n:${label}) RETURN count(n) AS n`);
    return (r.records[0]?.get('n') as number) ?? 0;
  });
}

describe('inspection by id survives expiry, until the purge', () => {
  // Recall and list are gated on liveness; inspection by id deliberately is not,
  // so an operator can still see what lapsed or was deleted. The retention sweep
  // is what finally ends that — which makes the grace period the window in which
  // a mistake is still visible and still fixable.
  test('a lapsed document is still readable by id', async () => {
    await clearDb();
    const id = await createResearch('lapsed body', daysAgo(1));

    const res = await app.inject({ method: 'GET', url: `/research/${id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.content).toBe('lapsed body');
  });

  test('and stops being readable once it is purged', async () => {
    await clearDb();
    const id = await createResearch('lapsed body', daysAgo(30));

    await container.research.purgeExpired(14, 100);

    const res = await app.inject({ method: 'GET', url: `/research/${id}`, headers: auth });
    expect(res.statusCode).toBe(404);
  });

  // The rescue path the grace period exists to allow.
  test('a lapsed document can be revived by raising its expiry', async () => {
    await clearDb();
    const id = await createResearch('rescuable body', daysAgo(1));

    const put = await app.inject({
      method: 'PUT',
      url: `/research/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { expiresAt: daysAhead(30).toISOString() },
    });
    expect(put.statusCode).toBe(200);

    // Back in the listing, which is the gated surface that actually matters.
    const list = await app.inject({
      method: 'GET',
      url: `/research?projectId=${PROJECT}`,
      headers: auth,
    });
    const rows = list.json().data as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toContain(id);
  });
});

describe('purgeExpired', () => {
  test('leaves documents that are still live', async () => {
    await clearDb();
    await createResearch('live body', daysAhead(5));

    const purged = await container.research.purgeExpired(0, 100);

    expect(purged).toBe(0);
    expect(await countNodes('Research')).toBe(1);
  });

  // The grace period is the whole safety margin: a document that lapsed
  // yesterday must survive a 14-day grace.
  test('leaves documents still inside the grace period', async () => {
    await clearDb();
    await createResearch('recently lapsed', daysAgo(1));

    const purged = await container.research.purgeExpired(14, 100);

    expect(purged).toBe(0);
    expect(await countNodes('Research')).toBe(1);
  });

  test('purges a document whose grace period has passed, with its chunks', async () => {
    await clearDb();
    await createResearch('long lapsed body', daysAgo(30));
    expect(await countNodes('ResearchChunk')).toBeGreaterThan(0);

    const purged = await container.research.purgeExpired(14, 100);

    expect(purged).toBe(1);
    expect(await countNodes('Research')).toBe(0);
    // Chunks are addressed by researchId, not only by edge, so a node-only
    // DETACH DELETE would strand them permanently.
    expect(await countNodes('ResearchChunk')).toBe(0);
  });

  // :ArchivedRevision snapshots hold the full pre-update state, body included.
  // Leaving them behind would keep the content the purge is meant to release.
  test('takes the revision snapshots that hold the old body', async () => {
    await clearDb();
    const id = await createResearch('original body', daysAhead(1));
    const patch = await app.inject({
      method: 'PUT',
      url: `/research/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: 'revised body', expiresAt: daysAgo(30).toISOString() },
    });
    expect(patch.statusCode).toBe(200);
    expect(await countNodes('ArchivedRevision')).toBeGreaterThan(0);

    const purged = await container.research.purgeExpired(14, 100);

    expect(purged).toBe(1);
    expect(await countNodes('ArchivedRevision')).toBe(0);
  });

  // An audit log that deletes itself alongside its subject is not an audit log.
  // Its payload carries field names and reasons, never content.
  test('keeps the audit trail', async () => {
    await clearDb();
    await createResearch('audited body', daysAgo(30));
    const auditBefore = await countNodes('AuditEvent');
    expect(auditBefore).toBeGreaterThan(0);

    await container.research.purgeExpired(14, 100);

    expect(await countNodes('AuditEvent')).toBe(auditBefore);
  });

  // Soft delete is implemented as `expiresAt = now`, so a soft-deleted document
  // ages into the purge on the same clock as a naturally expired one.
  test('reclaims soft-deleted documents once their grace has passed', async () => {
    await clearDb();
    const id = await createResearch('soft deleted body', daysAhead(365));
    const del = await app.inject({ method: 'DELETE', url: `/research/${id}`, headers: auth });
    expect(del.statusCode).toBe(200);

    // Just soft-deleted, so it is inside any non-zero grace.
    expect(await container.research.purgeExpired(1, 100)).toBe(0);
    // With no grace at all it goes immediately.
    expect(await container.research.purgeExpired(0, 100)).toBe(1);
    expect(await countNodes('Research')).toBe(0);
  });

  test('respects the batch limit so one tick cannot hold a long transaction', async () => {
    await clearDb();
    await createResearch('first lapsed', daysAgo(30));
    await createResearch('second lapsed', daysAgo(30));
    await createResearch('third lapsed', daysAgo(30));

    expect(await container.research.purgeExpired(14, 2)).toBe(2);
    expect(await countNodes('Research')).toBe(1);
    expect(await container.research.purgeExpired(14, 2)).toBe(1);
    expect(await countNodes('Research')).toBe(0);
  });

  test('a purged document is gone from the repository too, not just the API', async () => {
    await clearDb();
    const id = await createResearch('gone body', daysAgo(30));

    await container.research.purgeExpired(14, 100);

    const row = await read((tx) => ResearchRepository.get(tx, id));
    expect(row).toBeNull();
  });
});
