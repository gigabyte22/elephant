// Integration coverage for origin scope + actor on direct writes:
//   - POST /facts accepts agentId/sessionId/actor; the wire fact echoes the
//     scope and the audit event carries the caller's actor
//   - direct-written facts participate in agentScope filter/boost at recall
//     (the AgentOriginAnnotationStage fact-level fallback, end to end)
//   - PUT /preferences/:key accepts actor and threads it into audit
// Runs against the testcontainer Neo4j + fake adapters; wipes data on teardown.

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
  const llm = createFakeLLMAdapter();
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

describe('POST /facts with origin scope + actor', () => {
  test('wire fact echoes agentId/sessionId; audit event carries the actor', async () => {
    const res = await postJson('/facts', {
      content: 'the deploy dashboard lives behind the vpn',
      agentId: 'assistant',
      sessionId: 'telegram:42',
      actor: 'assistant',
    });
    expect(res.statusCode).toBe(200);
    const fact = res.json().data;
    expect(fact.agentId).toBe('assistant');
    expect(fact.sessionId).toBe('telegram:42');

    const audit = await getAuth(`/audit/${fact.id}`);
    expect(audit.statusCode).toBe(200);
    const events = audit.json().data.events as Array<{ kind: string; actor?: string }>;
    const create = events.find((e) => e.kind === 'create');
    expect(create?.actor).toBe('assistant');
  });

  test('actor omitted → audit falls back to the ingest actor', async () => {
    const res = await postJson('/facts', {
      content: 'the staging cluster is rebuilt nightly',
    });
    expect(res.statusCode).toBe(200);
    const fact = res.json().data;
    expect(fact.agentId).toBeUndefined();
    expect(fact.sessionId).toBeUndefined();

    const audit = await getAuth(`/audit/${fact.id}`);
    const events = audit.json().data.events as Array<{ kind: string; actor?: string }>;
    expect(events.find((e) => e.kind === 'create')?.actor).toBe('memory-ingest');
  });

  test('direct-written facts participate in agentScope=filter at recall', async () => {
    await postJson('/facts', {
      content: 'gadget rollout owned by team alpha squirrel',
      agentId: 'alpha',
    });
    await postJson('/facts', {
      content: 'gadget rollout owned by team beta squirrel',
      agentId: 'beta',
    });

    const res = await getAuth(
      '/recall?q=gadget%20rollout%20squirrel&agentId=alpha&agentScope=filter',
    );
    expect(res.statusCode).toBe(200);
    const facts = res.json().data.facts as Array<{
      agentId?: string;
      originAgentId?: string | null;
    }>;
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      // Facts from other agents must be excluded; shared (unscoped) may remain.
      expect(f.originAgentId === 'alpha' || f.originAgentId === null).toBe(true);
      expect(f.originAgentId).not.toBe('beta');
    }
    expect(facts.some((f) => f.originAgentId === 'alpha')).toBe(true);
  });
});

describe('PUT /preferences/:key with actor', () => {
  test('create and supersede events carry the caller actor', async () => {
    const first = await app.inject({
      method: 'PUT',
      url: '/preferences/favorite-shell',
      headers: json,
      payload: { value: 'zsh', actor: 'assistant' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'PUT',
      url: '/preferences/favorite-shell',
      headers: json,
      payload: { value: 'fish', actor: 'scheduler-agent' },
    });
    expect(second.statusCode).toBe(200);

    const audit = await getAuth('/audit?actor=assistant&limit=50');
    expect(audit.statusCode).toBe(200);
    const events = audit.json().data as Array<{ kind: string; targetKind: string; actor?: string }>;
    expect(events.some((e) => e.targetKind === 'preference' && e.kind === 'create')).toBe(true);

    const superseded = await getAuth('/audit?actor=scheduler-agent&limit=50');
    const supersedeEvents = superseded.json().data as Array<{ kind: string; targetKind: string }>;
    expect(
      supersedeEvents.some((e) => e.targetKind === 'preference' && e.kind === 'supersede'),
    ).toBe(true);
  });
});
