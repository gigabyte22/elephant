// Deletion vs supersession vs prune.
//
// All three used to write nothing but `validTo`, which produced two defects:
//   1. DELETE on an already-superseded fact overwrote its historical
//      event-time validTo with `now`, so /timeline reported the retracted
//      claim as live for the whole intervening window.
//   2. ?includeSuperseded=1 (and any asOf before the deletion) resurrected
//      user-deleted facts, because validAtClause emitted no predicate there.
//
// Redaction is now retroactive across every read path; prune deliberately is
// not, because a pruned claim really did hold.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { FactRepository } from '../../src/repositories/FactRepository.ts';
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

const CONTENT = 'the deploy runbook lives in the ops wiki';

async function saveFact(content: string, validFrom?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/facts',
    headers: json,
    payload: { content, ...(validFrom ? { validFrom } : {}) },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

async function rawFact(id: string) {
  return read((tx) => FactRepository.get(tx, id));
}

async function recallIds(extra: Record<string, string> = {}): Promise<string[]> {
  const params = new URLSearchParams({ q: CONTENT, limit: '20', ...extra });
  const res = await app.inject({ method: 'GET', url: `/recall?${params}`, headers: auth });
  expect(res.statusCode).toBe(200);
  return (res.json().data.facts as Array<{ id: string }>).map((f) => f.id);
}

describe('DELETE does not corrupt superseded history', () => {
  test('deleting a superseded fact leaves its event-time validTo intact', async () => {
    const oldId = await saveFact(CONTENT, '2026-01-01T00:00:00.000Z');
    const newId = await saveFact(`${CONTENT} (updated)`, '2026-03-01T00:00:00.000Z');

    const sup = await app.inject({
      method: 'POST',
      url: `/facts/${oldId}/supersede`,
      headers: json,
      payload: { newFactId: newId, reason: 'moved' },
    });
    expect(sup.statusCode).toBe(200);

    const supersededAtEventTime = (await rawFact(oldId))?.validTo;
    expect(supersededAtEventTime?.toISOString()).toBe('2026-03-01T00:00:00.000Z');

    const del = await app.inject({ method: 'DELETE', url: `/facts/${oldId}`, headers: auth });
    expect(del.statusCode).toBe(200);

    const after = await rawFact(oldId);
    // The whole point: validTo is untouched, and deletion is recorded
    // separately. Previously this became `now`, silently rewriting history.
    expect(after?.validTo?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(after?.deletedAt).not.toBeNull();
  });

  test('deleting a live fact closes its interval', async () => {
    const id = await saveFact(CONTENT);
    expect((await rawFact(id))?.validTo).toBeNull();

    await app.inject({ method: 'DELETE', url: `/facts/${id}`, headers: auth });

    const after = await rawFact(id);
    expect(after?.validTo).not.toBeNull();
    expect(after?.deletedAt).not.toBeNull();
  });
});

describe('redaction is retroactive', () => {
  test('a deleted fact is gone from recall, includeSuperseded, and any asOf', async () => {
    const id = await saveFact(CONTENT, '2026-01-01T00:00:00.000Z');
    expect(await recallIds()).toContain(id);

    await app.inject({ method: 'DELETE', url: `/facts/${id}`, headers: auth });

    expect(await recallIds()).not.toContain(id);
    // The branch that used to return it.
    expect(await recallIds({ includeSuperseded: 'true' })).not.toContain(id);
    // And any instant when it was demonstrably live.
    expect(await recallIds({ asOf: '2026-02-01T00:00:00.000Z' })).not.toContain(id);
    expect(
      await recallIds({ asOf: '2026-02-01T00:00:00.000Z', includeSuperseded: 'true' }),
    ).not.toContain(id);
  });

  test('and gone from /timeline at an instant it covered', async () => {
    const id = await saveFact(CONTENT, '2026-01-01T00:00:00.000Z');
    const at = '2026-02-01T00:00:00.000Z';

    const before = await app.inject({ method: 'GET', url: `/timeline?at=${at}`, headers: auth });
    expect((before.json().data.facts as Array<{ id: string }>).map((f) => f.id)).toContain(id);

    await app.inject({ method: 'DELETE', url: `/facts/${id}`, headers: auth });

    const after = await app.inject({ method: 'GET', url: `/timeline?at=${at}`, headers: auth });
    expect((after.json().data.facts as Array<{ id: string }>).map((f) => f.id)).not.toContain(id);
  });
});

describe('prune is a system forget, not a redaction', () => {
  test('a pruned fact keeps answering timeline and includeSuperseded', async () => {
    const id = await saveFact(CONTENT, '2026-01-01T00:00:00.000Z');
    const prunedAt = new Date();
    expect(await write((tx) => FactRepository.prune(tx, id, prunedAt))).toBe(true);

    const after = await rawFact(id);
    expect(after?.prunedAt).not.toBeNull();
    expect(after?.deletedAt).toBeNull();

    // Still legitimate history — the claim really did hold.
    expect(await recallIds({ includeSuperseded: 'true' })).toContain(id);
    const at = '2026-02-01T00:00:00.000Z';
    const timeline = await app.inject({ method: 'GET', url: `/timeline?at=${at}`, headers: auth });
    expect((timeline.json().data.facts as Array<{ id: string }>).map((f) => f.id)).toContain(id);

    // But not live.
    expect(await recallIds()).not.toContain(id);
  });

  test('prune refuses to re-close an already-superseded interval', async () => {
    const oldId = await saveFact(CONTENT, '2026-01-01T00:00:00.000Z');
    const newId = await saveFact(`${CONTENT} (updated)`, '2026-03-01T00:00:00.000Z');
    await app.inject({
      method: 'POST',
      url: `/facts/${oldId}/supersede`,
      headers: json,
      payload: { newFactId: newId, reason: 'moved' },
    });

    expect(await write((tx) => FactRepository.prune(tx, oldId, new Date()))).toBe(false);
    expect((await rawFact(oldId))?.validTo?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('deletion is idempotent and audited', () => {
  test('a second DELETE does not append another audit event', async () => {
    const id = await saveFact(CONTENT);
    await app.inject({ method: 'DELETE', url: `/facts/${id}`, headers: auth });
    const firstDeletedAt = (await rawFact(id))?.deletedAt;

    await app.inject({ method: 'DELETE', url: `/facts/${id}`, headers: auth });
    expect((await rawFact(id))?.deletedAt?.toISOString()).toBe(firstDeletedAt?.toISOString());

    const audit = await app.inject({ method: 'GET', url: `/audit/${id}`, headers: auth });
    const events = audit.json().data.events as Array<{ kind: string }>;
    expect(events.filter((e) => e.kind === 'soft_delete')).toHaveLength(1);
  });

  test('the pre-delete state is snapshotted as a revision', async () => {
    const id = await saveFact(CONTENT, '2026-01-01T00:00:00.000Z');
    await app.inject({ method: 'DELETE', url: `/facts/${id}`, headers: auth });

    const audit = await app.inject({ method: 'GET', url: `/audit/${id}`, headers: auth });
    const revisions = audit.json().data.revisions as Array<{ snapshot: unknown }>;
    expect(revisions.length).toBeGreaterThan(0);
    // The snapshot must capture the state BEFORE the delete: interval open.
    const raw = revisions[0]!.snapshot;
    const snapshot = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      validTo: string | null;
      deletedAt?: string | null;
    };
    expect(snapshot.validTo).toBeNull();
    expect(snapshot.deletedAt ?? null).toBeNull();
  });
});

describe('a deleted fact cannot be resurrected', () => {
  test('supersede against it is refused', async () => {
    const oldId = await saveFact(CONTENT, '2026-01-01T00:00:00.000Z');
    const newId = await saveFact(`${CONTENT} (updated)`, '2026-03-01T00:00:00.000Z');
    await app.inject({ method: 'DELETE', url: `/facts/${oldId}`, headers: auth });
    const deletedValidTo = (await rawFact(oldId))?.validTo?.toISOString();

    await app.inject({
      method: 'POST',
      url: `/facts/${oldId}/supersede`,
      headers: json,
      payload: { newFactId: newId, reason: 'moved' },
    });

    expect((await rawFact(oldId))?.validTo?.toISOString()).toBe(deletedValidTo);
    const edges = await read(async (tx) => {
      const r = await tx.run(
        'MATCH (:Fact {id: $newId})-[r:SUPERSEDES]->(:Fact {id: $oldId}) RETURN count(r) AS n',
        { newId, oldId },
      );
      return (r.records[0]?.get('n') as number) ?? 0;
    });
    expect(edges).toBe(0);
  });

  test('re-POSTing its id is a conflict, not an undelete', async () => {
    const id = await saveFact(CONTENT);
    await app.inject({ method: 'DELETE', url: `/facts/${id}`, headers: auth });

    const res = await app.inject({
      method: 'POST',
      url: '/facts',
      headers: json,
      payload: { id, content: CONTENT },
    });
    expect(res.statusCode).toBe(409);
    expect((await rawFact(id))?.deletedAt).not.toBeNull();
  });
});

describe('dashboard counts separate the three lifecycles', () => {
  test('active, superseded, pruned and softDeleted are distinct buckets', async () => {
    const liveId = await saveFact('live fact', '2026-01-01T00:00:00.000Z');
    const oldId = await saveFact('old claim', '2026-01-01T00:00:00.000Z');
    const newId = await saveFact('new claim', '2026-03-01T00:00:00.000Z');
    await app.inject({
      method: 'POST',
      url: `/facts/${oldId}/supersede`,
      headers: json,
      payload: { newFactId: newId, reason: 'changed' },
    });
    const prunedId = await saveFact('stale fact', '2026-01-01T00:00:00.000Z');
    await write((tx) => FactRepository.prune(tx, prunedId, new Date()));
    const deletedId = await saveFact('redacted fact', '2026-01-01T00:00:00.000Z');
    await app.inject({ method: 'DELETE', url: `/facts/${deletedId}`, headers: auth });

    const res = await app.inject({ method: 'GET', url: '/dashboard/api/stats', headers: auth });
    expect(res.statusCode).toBe(200);
    const facts = res.json().data.facts as Record<string, number>;

    // liveId + newId are the only untouched rows; oldId was superseded,
    // prunedId pruned, deletedId redacted — one of each, no double-counting.
    expect(facts.active).toBe(2);
    expect(facts.superseded).toBe(1);
    expect(facts.pruned).toBe(1);
    expect(facts.softDeleted).toBe(1);
    expect(liveId && oldId && newId && prunedId && deletedId).toBeTruthy();
  });
});
