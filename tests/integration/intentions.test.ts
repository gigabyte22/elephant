// Integration coverage for the :Intention prospective-memory type: lifecycle
// (create / due-query / complete / cancel), bi-temporal + audit side effects,
// idempotency, scope filtering, and flag-gated recall. Runs against the
// testcontainer Neo4j + fake adapters. Wipes data on teardown.

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

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

beforeAll(async () => {
  const llm = createFakeLLMAdapter({});
  const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  container = await bootstrap({ llm, embedder });
  app = await buildHttpServer(container);
  await app.ready();
});

afterAll(async () => {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
  await app?.close();
  await shutdown();
});

type Response = Awaited<ReturnType<typeof app.inject>>;

function postJson(url: string, payload: unknown): Promise<Response> {
  return app.inject({ method: 'POST', url, headers: json, payload: payload as object });
}

function getAuth(url: string): Promise<Response> {
  return app.inject({ method: 'GET', url, headers: auth });
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('intention create validation', () => {
  test('accepts dueAt-only, triggerHint-only, and both', async () => {
    const dueOnly = await postJson('/intentions', {
      content: 'renew car registration',
      dueAt: iso(60_000),
    });
    expect(dueOnly.statusCode).toBe(200);
    expect(dueOnly.json().data.status).toBe('pending');

    const triggerOnly = await postJson('/intentions', {
      content: 'mention the discount',
      triggerHint: 'when the user next asks about billing',
    });
    expect(triggerOnly.statusCode).toBe(200);
    expect(triggerOnly.json().data.dueAt).toBeNull();

    const both = await postJson('/intentions', {
      content: 'follow up on invoice',
      dueAt: iso(120_000),
      triggerHint: 'when invoices come up',
    });
    expect(both.statusCode).toBe(200);
  });

  test('rejects an intention with neither dueAt nor triggerHint', async () => {
    const res = await postJson('/intentions', { content: 'do something, sometime' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /intentions/due', () => {
  const agentId = 'due-agent';

  test('returns only pending + due, ordered by dueAt asc, excluding trigger-only and future', async () => {
    const overdueMore = await postJson('/intentions', {
      content: 'overdue A',
      dueAt: iso(-120_000),
      scope: { agentId },
    });
    const overdueLess = await postJson('/intentions', {
      content: 'overdue B',
      dueAt: iso(-60_000),
      scope: { agentId },
    });
    // future-due — must NOT appear
    await postJson('/intentions', {
      content: 'future',
      dueAt: iso(3_600_000),
      scope: { agentId },
    });
    // trigger-only — never "due"
    await postJson('/intentions', {
      content: 'trigger only',
      triggerHint: 'someday',
      scope: { agentId },
    });

    const res = await getAuth(`/intentions/due?agentId=${agentId}`);
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((i: { id: string }) => i.id);
    // Most-overdue first.
    expect(ids).toEqual([overdueMore.json().data.id, overdueLess.json().data.id]);
  });
});

describe('complete / cancel lifecycle', () => {
  test('complete flips status, sets completedAt + validTo, writes revision + audit, idempotent', async () => {
    const created = await postJson('/intentions', {
      content: 'send the Friday report',
      dueAt: iso(-1000),
      actor: 'tester',
    });
    const id = created.json().data.id;

    const done = await postJson(`/intentions/${id}/complete`, { actor: 'cron', reason: 'fired' });
    expect(done.statusCode).toBe(200);
    expect(done.json().data.status).toBe('completed');
    expect(done.json().data.completedAt).not.toBeNull();
    expect(done.json().data.validTo).not.toBeNull();

    const audit1 = await getAuth(`/audit/${id}`);
    const events1 = audit1.json().data.events as Array<{ kind: string }>;
    const updates1 = events1.filter((e) => e.kind === 'update').length;
    expect(events1.some((e) => e.kind === 'create')).toBe(true);
    expect(updates1).toBe(1);
    expect((audit1.json().data.revisions as unknown[]).length).toBe(1);

    // Idempotent: completing again is a no-op (no second update event).
    const again = await postJson(`/intentions/${id}/complete`, { actor: 'cron' });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.status).toBe('completed');
    const audit2 = await getAuth(`/audit/${id}`);
    const updates2 = (audit2.json().data.events as Array<{ kind: string }>).filter(
      (e) => e.kind === 'update',
    ).length;
    expect(updates2).toBe(1);
  });

  test('cancel on a completed intention is rejected', async () => {
    const created = await postJson('/intentions', { content: 'terminal test', dueAt: iso(-1000) });
    const id = created.json().data.id;
    await postJson(`/intentions/${id}/complete`, {});
    const res = await postJson(`/intentions/${id}/cancel`, {});
    expect(res.statusCode).toBe(400);
  });

  test('cancel flips a pending intention to cancelled', async () => {
    const created = await postJson('/intentions', {
      content: 'cancel me',
      triggerHint: 'never',
    });
    const id = created.json().data.id;
    const res = await postJson(`/intentions/${id}/cancel`, { reason: 'no longer needed' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('cancelled');
  });
});

describe('recurring fires', () => {
  test('markFired bumps fireCount + lastFiredAt, audits each fire, stays pending', async () => {
    const created = await postJson('/intentions', {
      content: 'weekday morning briefing',
      recurring: true,
      schedule: '0 7 * * 1-5',
      dueAt: iso(60_000),
      actor: 'tester',
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.recurring).toBe(true);
    expect(created.json().data.schedule).toBe('0 7 * * 1-5');
    expect(created.json().data.fireCount).toBe(0);
    const id = created.json().data.id;

    const fire1 = await postJson(`/intentions/${id}/fired`, { actor: 'cron' });
    expect(fire1.statusCode).toBe(200);
    expect(fire1.json().data.fireCount).toBe(1);
    expect(fire1.json().data.lastFiredAt).not.toBeNull();
    expect(fire1.json().data.status).toBe('pending'); // recurring never self-completes

    const fire2 = await postJson(`/intentions/${id}/fired`, { actor: 'cron' });
    expect(fire2.json().data.fireCount).toBe(2);

    // Each fire leaves a durable (no-TTL) audit event.
    const audit = await getAuth(`/audit/${id}`);
    const fired = (
      audit.json().data.events as Array<{ kind: string; payload: { event?: string } }>
    ).filter((e) => e.payload?.event === 'fired');
    expect(fired.length).toBe(2);
  });

  test('a schedule-only intention (no dueAt, no triggerHint) is valid', async () => {
    const res = await postJson('/intentions', {
      content: 'recurring with no precomputed due',
      recurring: true,
      schedule: '0 9 * * *',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('scope filtering', () => {
  test('GET /intentions filters by agentId and status', async () => {
    const agentId = 'scoped-agent';
    await postJson('/intentions', {
      content: 'scoped pending',
      dueAt: iso(5000),
      scope: { agentId },
    });
    const created = await postJson('/intentions', {
      content: 'scoped to cancel',
      dueAt: iso(5000),
      scope: { agentId },
    });
    await postJson(`/intentions/${created.json().data.id}/cancel`, {});

    const pending = await getAuth(`/intentions?agentId=${agentId}&status=pending`);
    const pendingContents = pending.json().data.map((i: { content: string }) => i.content);
    expect(pendingContents).toContain('scoped pending');
    expect(pendingContents).not.toContain('scoped to cancel');

    const otherAgent = await getAuth('/intentions?agentId=some-other-agent');
    expect(otherAgent.json().data.every((i: { agentId?: string }) => i.agentId !== agentId)).toBe(
      true,
    );
  });
});

describe('recall integration (flag-gated)', () => {
  test('includeIntentions surfaces pending; baseline omits; completed never surface', async () => {
    const q = 'quarterly tax filing reminder';
    const pending = await postJson('/intentions', { content: q, dueAt: iso(10_000) });
    const completed = await postJson('/intentions', { content: `${q} done`, dueAt: iso(10_000) });
    await postJson(`/intentions/${completed.json().data.id}/complete`, {});

    const baseline = await getAuth(`/recall?q=${encodeURIComponent(q)}`);
    expect(baseline.json().data.intentions).toBeUndefined();

    const withIntentions = await getAuth(
      `/recall?q=${encodeURIComponent(q)}&includeIntentions=true`,
    );
    const recalled = (withIntentions.json().data.intentions ?? []) as Array<{ id: string }>;
    const recalledIds = recalled.map((i) => i.id);
    expect(recalledIds).toContain(pending.json().data.id);
    expect(recalledIds).not.toContain(completed.json().data.id);
  });
});
