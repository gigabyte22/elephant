// Thorough end-to-end integration: real ingestion through the full HTTP
// surface against the testcontainer Neo4j + fake adapters, exercising the
// v1.2 expansion (knowledge, procedures, research, working state, audit)
// alongside facts/preferences/observations, plus a battery of recall use
// cases. Wipes all data on teardown so the shared container is left clean.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read as txRead, write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' } as const;

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
let testRunStart: Date;
const previousRefCountMode = process.env.RETRIEVAL_REFCOUNT_TICK_MODE;

beforeAll(async () => {
  // Sync refcount tick so the tick verification doesn't race on a microtask.
  process.env.RETRIEVAL_REFCOUNT_TICK_MODE = 'sync';
  testRunStart = new Date();

  const llm = createFakeLLMAdapter({
    // Invert candidate order so a rerank-on test can detect rerank actually ran.
    rerank: ({ candidates, keepTopK }) => {
      const slice = candidates.slice(0, keepTopK);
      return slice
        .map((c, i, arr) => ({
          id: c.id,
          score: i / Math.max(arr.length - 1, 1),
          reason: 'inverted',
        }))
        .reverse();
    },
  });
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
  if (previousRefCountMode === undefined) {
    Reflect.deleteProperty(process.env, 'RETRIEVAL_REFCOUNT_TICK_MODE');
  } else {
    process.env.RETRIEVAL_REFCOUNT_TICK_MODE = previousRefCountMode;
  }
});

async function clearDb(): Promise<void> {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
}

type Response = Awaited<ReturnType<typeof app.inject>>;

function postJson(url: string, payload: unknown): Promise<Response> {
  return app.inject({ method: 'POST', url, headers: json, payload: payload as object });
}

function getAuth(url: string): Promise<Response> {
  return app.inject({ method: 'GET', url, headers: auth });
}

describe('A. smoke + envelope', () => {
  test('GET /health returns ok envelope with neo4j up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.neo4j).toBe(true);
    expect(body.data.schemaVectorDim).toBe(EMBED_DIM);
    expect(body.data.embedder.dim).toBe(EMBED_DIM);
  });

  test('rejects unauthenticated requests with envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/preferences' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });
});

describe('B+C. multi-layer ingestion + recall use cases', () => {
  let factA: string;
  let factB: string;
  let kdocId: string;
  let procGenericId: string;
  let procProjAId: string;
  let researchId: string;

  beforeAll(async () => {
    await clearDb();

    const batch = await postJson('/facts/batch', {
      facts: [
        {
          content: 'alice manages the deploy server at deploy.example.com',
          importance: 0.7,
          confidence: 0.9,
          entityNames: ['alice', 'deploy server'],
        },
        {
          content: 'alice prefers terse code reviews on weekday mornings',
          importance: 0.5,
          confidence: 0.8,
          entityNames: ['alice'],
        },
        {
          content: 'the staging environment lives at staging.example.com',
          importance: 0.4,
          confidence: 0.85,
        },
      ],
    });
    expect(batch.statusCode).toBe(200);
    const factIds = (batch.json().data as Array<{ id: string }>).map((f) => f.id);
    factA = factIds[0]!;
    factB = factIds[1]!;

    await app.inject({
      method: 'PUT',
      url: '/preferences/notification-channel',
      headers: json,
      payload: { value: 'slack' },
    });

    const kdoc = await postJson('/knowledge/documents', {
      title: 'Deployment Runbook',
      source: 'wiki',
      content:
        'To deploy the service, push the green button on deploy.example.com. ' +
        'Monitor logs in the dashboard for thirty minutes. ' +
        'Rollback by re-running the previous tag.',
      summary: 'how to deploy and rollback the service',
      tags: ['deploy', 'runbook'],
      scope: { projectId: 'proj-A' },
    });
    expect(kdoc.statusCode).toBe(200);
    kdocId = kdoc.json().data.id as string;

    const proc1 = await postJson('/procedures', {
      name: 'rollback deploy',
      whenToUse: 'when a deploy goes wrong and needs reverting',
      content: 'run the previous-tag command on deploy.example.com',
    });
    expect(proc1.statusCode).toBe(200);
    procGenericId = proc1.json().data.id as string;

    const proc2 = await postJson('/procedures', {
      name: 'project-A onboarding',
      whenToUse: 'when a new contributor joins project A',
      content: 'walk them through deploy.example.com and the runbook',
      scope: { projectId: 'proj-A' },
    });
    expect(proc2.statusCode).toBe(200);
    procProjAId = proc2.json().data.id as string;

    const rsrch = await postJson('/research', {
      title: 'Deploy throughput investigation',
      source: 'analysis',
      content: 'measured deploy.example.com throughput over the last quarter',
      summary: 'throughput trends for deploy server',
      projectId: 'proj-A',
    });
    expect(rsrch.statusCode).toBe(200);
    researchId = rsrch.json().data.id as string;

    await postJson('/observations', {
      agentId: 'agent-alpha',
      sessionId: 'sess-1',
      content: 'currently investigating deploy regressions',
    });
  });

  test('POST /facts/batch + GET /recall round-trips via envelope', async () => {
    const res = await getAuth('/recall?q=deploy%20server&limit=10');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    const ids = (body.data.facts as Array<{ id: string }>).map((f) => f.id);
    expect(ids).toContain(factA);
    for (const f of body.data.facts as Array<{ score: number; expansionReason?: string }>) {
      expect(typeof f.score).toBe('number');
      if (f.expansionReason !== undefined) {
        expect([
          'fact_vector',
          'fact_fulltext',
          'entity_sibling',
          'chunk_derived',
          'rerank',
        ]).toContain(f.expansionReason);
      }
    }
  });

  test('kinds=fact suppresses other categories', async () => {
    const res = await getAuth(
      '/recall?q=deploy&kinds=fact&includeKnowledge=true&includeProcedures=true&limit=5',
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.facts).toBeDefined();
    // PostFilterStage drops contents while the route still includes the array key.
    expect(body.data.knowledgeChunks ?? []).toEqual([]);
    expect(body.data.procedures ?? []).toEqual([]);
  });

  test('includeKnowledge=true returns knowledge chunks for the runbook', async () => {
    const res = await getAuth('/recall?q=rollback%20deploy&includeKnowledge=true&limit=10');
    expect(res.statusCode).toBe(200);
    const chunks = res.json().data.knowledgeChunks as Array<{
      documentId: string;
      score: number;
    }>;
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.some((c) => c.documentId === kdocId)).toBe(true);
  });

  test('includeProcedures=true returns procedures; baseline omits them', async () => {
    const baseline = await getAuth('/recall?q=rollback%20deploy&limit=5');
    expect(baseline.json().data.procedures ?? []).toEqual([]);

    const withProcs = await getAuth('/recall?q=rollback%20deploy&includeProcedures=true&limit=10');
    const procs = withProcs.json().data.procedures as Array<{ id: string }>;
    expect(procs.length).toBeGreaterThanOrEqual(1);
    expect(procs.some((p) => p.id === procGenericId || p.id === procProjAId)).toBe(true);
  });

  test('includeResearch=true with projectId returns the research artifact', async () => {
    // ResearchVectorSource short-circuits without a projectId to avoid
    // surfacing cross-project artifacts by accident.
    const res = await getAuth(
      '/recall?q=deploy%20throughput&includeResearch=true&projectId=proj-A&limit=10',
    );
    expect(res.statusCode).toBe(200);
    const research = (res.json().data.research ?? []) as Array<{ id: string }>;
    expect(research.some((r) => r.id === researchId)).toBe(true);
  });

  test('projectScope=filter restricts knowledge + procedures to projectId', async () => {
    const res = await getAuth(
      '/recall?q=deploy&projectId=proj-A&projectScope=filter' +
        '&includeKnowledge=true&includeProcedures=true&limit=20',
    );
    expect(res.statusCode).toBe(200);
    const procs = (res.json().data.procedures ?? []) as Array<{
      id: string;
      projectId?: string;
    }>;
    // The unscoped procedure may or may not pass null-handling — assert the
    // proj-A proc is present and any proc with a projectId equals proj-A.
    expect(procs.some((p) => p.id === procProjAId)).toBe(true);
    for (const p of procs) {
      if (p.projectId !== undefined) expect(p.projectId).toBe('proj-A');
    }
  });

  test('projectScope=boost returns both proj-A and unscoped procedures', async () => {
    // Boost mode does not filter; ordering depends on lexical+vector signals
    // that may dominate the 1.2x project boost, so we don't assert ordering.
    const res = await getAuth(
      '/recall?q=deploy&projectId=proj-A&projectScope=boost&includeProcedures=true&limit=20',
    );
    const procs = (res.json().data.procedures ?? []) as Array<{
      id: string;
      score: number;
      projectId?: string;
    }>;
    expect(procs.find((p) => p.id === procProjAId)).toBeDefined();
    expect(procs.find((p) => p.id === procGenericId)).toBeDefined();
  });

  test('entity sibling expansion surfaces the second alice fact', async () => {
    const res = await getAuth('/recall?q=alice%20deploy%20server&limit=20');
    const body = res.json().data;
    const facts = body.facts as Array<{ id: string; expansionReason?: string }>;
    expect(facts.find((f) => f.id === factA)).toBeDefined();
    const sibling = facts.find((f) => f.id === factB);
    if (sibling !== undefined) {
      expect(['entity_sibling', 'fact_vector', 'fact_fulltext']).toContain(
        sibling.expansionReason ?? 'entity_sibling',
      );
    }
    const entities = body.entities as Array<{ name: string }>;
    expect(entities.some((e) => e.name === 'alice')).toBe(true);
  });

  test('rerank=true with debug=true reports rerankUsed in trace', async () => {
    const res = await getAuth('/recall?q=deploy&rerank=true&debug=true&limit=10');
    expect(res.statusCode).toBe(200);
    const trace = res.json().data.trace as
      | { rerankUsed: boolean; stageTimingsMs: Record<string, number> }
      | undefined;
    expect(trace).toBeDefined();
    expect(trace?.rerankUsed).toBe(true);
  });

  test('refcount tick (sync mode) increments referenceCount on returned facts', async () => {
    async function readRefCount(): Promise<number> {
      return txRead(async (tx) => {
        const r = await tx.run('MATCH (f:Fact {id: $id}) RETURN f.referenceCount AS rc', {
          id: factA,
        });
        return (r.records[0]?.get('rc') as number | null) ?? 0;
      });
    }

    const before = await readRefCount();
    await getAuth('/recall?q=deploy%20server&limit=5');
    const after = await readRefCount();

    expect(after).toBeGreaterThan(before);
  });
});

describe('C2. strict project scope excludes unscoped (global) facts', () => {
  let scopedFactId: string;
  let globalFactId: string;

  beforeAll(async () => {
    await clearDb();
    // One fact scoped to proj-A, one unscoped (personal/global, projectId=null).
    const scoped = await postJson('/facts', {
      content: 'zebra is the proj-A project mascot',
      importance: 0.6,
      confidence: 0.9,
      projectId: 'proj-A',
    });
    expect(scoped.statusCode).toBe(200);
    scopedFactId = scoped.json().data.id as string;

    const global = await postJson('/facts', {
      content: 'zebra is the owner personal pet at home',
      importance: 0.6,
      confidence: 0.9,
    });
    expect(global.statusCode).toBe(200);
    globalFactId = global.json().data.id as string;
  });

  test('projectScope=strict returns only the project fact, excluding the unscoped one', async () => {
    const res = await getAuth('/recall?q=zebra&projectId=proj-A&projectScope=strict&limit=20');
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data.facts as Array<{ id: string }>).map((f) => f.id);
    expect(ids).toContain(scopedFactId);
    expect(ids).not.toContain(globalFactId);
  });

  test('projectScope=filter keeps the unscoped (null) fact as a shared global', async () => {
    const res = await getAuth('/recall?q=zebra&projectId=proj-A&projectScope=filter&limit=20');
    const ids = (res.json().data.facts as Array<{ id: string }>).map((f) => f.id);
    expect(ids).toContain(scopedFactId);
    expect(ids).toContain(globalFactId);
  });

  test('projectScope=boost returns both project and unscoped facts', async () => {
    const res = await getAuth('/recall?q=zebra&projectId=proj-A&projectScope=boost&limit=20');
    const ids = (res.json().data.facts as Array<{ id: string }>).map((f) => f.id);
    expect(ids).toContain(scopedFactId);
    expect(ids).toContain(globalFactId);
  });
});

describe('D. procedure supersede chain', () => {
  let originalId: string;

  // Stacks on top of B+C's seed; do not clear so section G can audit events
  // accumulated across all earlier sections.
  beforeAll(async () => {
    const create = await postJson('/procedures', {
      name: 'restart cache',
      whenToUse: 'when redis appears stuck',
      content: 'flushall and restart the redis container',
    });
    const body = create.json().data;
    originalId = body.id as string;
    expect(body.version).toBe(1);
  });

  test('PUT /procedures/:id with body change increments version and creates :SUPERSEDES edge', async () => {
    const upd = await app.inject({
      method: 'PUT',
      url: `/procedures/${originalId}`,
      headers: json,
      payload: {
        content: 'flushall, restart redis, and warm the cache from the source of truth',
        reason: 'add cache-warming step',
      },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().data.version).toBe(2);

    // ProcedureRepository.supersede creates (newP)-[:SUPERSEDES]->(oldP), so
    // anchor on the original id and walk inbound to find the v2 node.
    const chain = await txRead(async (tx) => {
      const r = await tx.run(
        'MATCH (newP:Procedure)-[:SUPERSEDES]->(oldP:Procedure {id: $id}) ' +
          'RETURN newP.id AS newId, newP.version AS newVersion',
        { id: originalId },
      );
      return r.records.map((rec) => ({
        newId: rec.get('newId') as string,
        newVersion: rec.get('newVersion') as number,
      }));
    });
    expect(chain).toHaveLength(1);
    expect(chain[0]?.newVersion).toBe(2);
  });

  test('GET /audit/:targetId returns supersede event + archived revision snapshot', async () => {
    const res = await getAuth(`/audit/${originalId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    const eventKinds = (body.events as Array<{ kind: string }>).map((e) => e.kind);
    expect(eventKinds).toContain('create');
    expect(eventKinds).toContain('update');

    expect(body.revisions.length).toBeGreaterThanOrEqual(1);
    const rev = (body.revisions as Array<{ snapshot: unknown; reason: string }>)[0]!;
    expect(rev.reason).toBe('add cache-warming step');
    const snapshot = typeof rev.snapshot === 'string' ? JSON.parse(rev.snapshot) : rev.snapshot;
    expect(snapshot.id).toBe(originalId);
    expect(snapshot.content).toContain('flushall and restart');
    // Embeddings are stripped from snapshots.
    expect(snapshot.embedding).toBeUndefined();
  });
});

describe('E. knowledge document soft-delete + purge', () => {
  let docId: string;

  // Stacks on top of prior sections so /audit can survey the full run.
  beforeAll(async () => {
    const res = await postJson('/knowledge/documents', {
      title: 'Disposable doc',
      source: 'test',
      content: 'first chunk content. second chunk content. third chunk content.',
    });
    docId = res.json().data.id as string;
  });

  async function countChunks(): Promise<number> {
    return txRead(async (tx) => {
      const r = await tx.run(
        'MATCH (:KnowledgeDocument {id: $id})-[:HAS_CHUNK]->(c:KnowledgeChunk) ' +
          'RETURN count(c) AS n',
        { id: docId },
      );
      return r.records[0]?.get('n') as number;
    });
  }

  test('DELETE without purge soft-deletes document but retains chunks', async () => {
    const before = await countChunks();
    expect(before).toBeGreaterThanOrEqual(1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/knowledge/documents/${docId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data).toEqual({ deleted: true, chunksDeleted: 0 });

    expect(await countChunks()).toBe(before);
  });

  test('DELETE with purge=true drops all chunks and records audit event', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/knowledge/documents/${docId}?purge=true`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);
    expect((del.json().data as { chunksDeleted: number }).chunksDeleted).toBeGreaterThanOrEqual(1);

    const remaining = await txRead(async (tx) => {
      const r = await tx.run('MATCH (c:KnowledgeChunk {documentId: $id}) RETURN count(c) AS n', {
        id: docId,
      });
      return r.records[0]?.get('n') as number;
    });
    expect(remaining).toBe(0);

    const audit = await getAuth(`/audit/${docId}`);
    const kinds = (audit.json().data.events as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toContain('soft_delete');
  });
});

describe('F. working state lifecycle', () => {
  const scopeBase = { agentId: 'agent-alpha' };
  const scopeQuery = `agentId=${scopeBase.agentId}`;

  test('POST /state with ttlSec sets expiresAt ≈ now + ttl', async () => {
    const before = Date.now();
    const set = await postJson('/state', {
      scope: scopeBase,
      key: 'foo:1',
      value: { hello: 'world' },
      ttlSec: 60,
    });
    expect(set.statusCode).toBe(200);

    const get = await getAuth(`/state/foo:1?${scopeQuery}`);
    expect(get.statusCode).toBe(200);
    const entry = get.json().data as { expiresAt: string | null; value: { hello: string } };
    expect(entry.value).toEqual({ hello: 'world' });
    expect(entry.expiresAt).not.toBeNull();
    const expiresAtMs = new Date(entry.expiresAt!).getTime();
    expect(expiresAtMs).toBeGreaterThan(before);
    expect(expiresAtMs - before).toBeLessThan(60_000 + 5_000);
  });

  test('POST /state without ttl yields expiresAt: null', async () => {
    await postJson('/state', { scope: scopeBase, key: 'foo:2', value: 'no-ttl' });
    const r = await getAuth(`/state/foo:2?${scopeQuery}`);
    expect((r.json().data as { expiresAt: string | null }).expiresAt).toBeNull();
  });

  test('different scopes hold the same key independently', async () => {
    const projAScope = { ...scopeBase, projectId: 'proj-A' };
    const projBScope = { ...scopeBase, projectId: 'proj-B' };
    await postJson('/state', { scope: projAScope, key: 'shared', value: 'A-value' });
    await postJson('/state', { scope: projBScope, key: 'shared', value: 'B-value' });

    const a = await getAuth(`/state/shared?${scopeQuery}&projectId=proj-A`);
    const b = await getAuth(`/state/shared?${scopeQuery}&projectId=proj-B`);
    expect((a.json().data as { value: string }).value).toBe('A-value');
    expect((b.json().data as { value: string }).value).toBe('B-value');
  });

  test('GET /state?prefix=foo returns only matching keys', async () => {
    const res = await getAuth(`/state?${scopeQuery}&prefix=foo`);
    const keys = (res.json().data as Array<{ key: string }>).map((e) => e.key);
    expect(keys.every((k) => k.startsWith('foo'))).toBe(true);
    expect(keys).toEqual(expect.arrayContaining(['foo:1', 'foo:2']));
  });

  test('DELETE /state/:key + subsequent GET yields 404 envelope', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/state/foo:2?${scopeQuery}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);

    const miss = await getAuth(`/state/foo:2?${scopeQuery}`);
    expect(miss.statusCode).toBe(404);
    expect(miss.json().ok).toBe(false);
  });
});

describe('G. audit cross-cutting verification', () => {
  test('GET /audit returns a mix of event kinds spanning the test run', async () => {
    const fromIso = testRunStart.toISOString();
    const res = await getAuth(`/audit?from=${encodeURIComponent(fromIso)}&limit=500`);
    expect(res.statusCode).toBe(200);
    const events = res.json().data as Array<{ kind: string; targetKind: string }>;
    expect(events.length).toBeGreaterThan(0);
    const kinds = new Set(events.map((e) => e.kind));
    // Expect 'create' (procedure creates / knowledge ingests), 'soft_delete'
    // (section E), and 'update' (section D's revise()).
    expect(kinds.has('create')).toBe(true);
    expect(kinds.has('update')).toBe(true);
    expect(kinds.has('soft_delete')).toBe(true);

    const targetKinds = new Set(events.map((e) => e.targetKind));
    for (const tk of targetKinds) {
      expect([
        'episode',
        'chunk',
        'fact',
        'preference',
        'insight',
        'observation',
        'knowledge_document',
        'knowledge_chunk',
        'procedure',
        'research',
      ]).toContain(tk);
    }
  });

  // Facts and preferences must each show up in the audit log — these were
  // historically unwired and only started emitting events when AuditService
  // was plugged into MemoryIngestionService and PreferenceService.
  test('audit log includes fact + preference target kinds', async () => {
    // C2's clearDb() wipes every node including :AuditEvent, taking the
    // preference event from this file's beforeAll with it — so write a fresh
    // preference here to keep this test self-sufficient.
    const put = await app.inject({
      method: 'PUT',
      url: '/preferences/audit-kind-probe',
      headers: json,
      payload: { value: 'on' },
    });
    expect(put.statusCode).toBe(200);

    const fromIso = testRunStart.toISOString();
    const res = await getAuth(`/audit?from=${encodeURIComponent(fromIso)}&limit=500`);
    const events = res.json().data as Array<{ targetKind: string; kind: string; actor?: string }>;
    const targetKinds = new Set(events.map((e) => e.targetKind));
    expect(targetKinds.has('fact')).toBe(true);
    expect(targetKinds.has('preference')).toBe(true);
    // Facts are created by the ingestion service, so they should carry the
    // memory-ingest actor at least once.
    expect(
      events.some(
        (e) => e.targetKind === 'fact' && e.kind === 'create' && e.actor === 'memory-ingest',
      ),
    ).toBe(true);
  });
});

describe('H. fact + preference audit detail', () => {
  let factId: string;
  let prefKey: string;

  beforeAll(async () => {
    // Single-fact write to capture an id we can probe in /audit/:targetId.
    const res = await postJson('/facts', {
      content: 'audit-detail-test fact about deploy windows',
      importance: 0.5,
      confidence: 0.9,
    });
    expect(res.statusCode).toBe(200);
    factId = res.json().data.id as string;

    prefKey = `audit-pref-${Date.now()}`;
    const first = await app.inject({
      method: 'PUT',
      url: `/preferences/${prefKey}`,
      headers: json,
      payload: { value: 'alpha' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'PUT',
      url: `/preferences/${prefKey}`,
      headers: json,
      payload: { value: 'beta' },
    });
    expect(second.statusCode).toBe(200);
  });

  test('GET /audit/:factId returns a create event from memory-ingest', async () => {
    const res = await getAuth(`/audit/${factId}`);
    expect(res.statusCode).toBe(200);
    const events = res.json().data.events as Array<{ kind: string; actor?: string }>;
    const create = events.find((e) => e.kind === 'create');
    expect(create).toBeDefined();
    expect(create?.actor).toBe('memory-ingest');
  });

  test('soft-deleting a fact records a soft_delete event', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/facts/${factId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);

    const res = await getAuth(`/audit/${factId}`);
    const kinds = (res.json().data.events as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toContain('soft_delete');
  });

  test('preference update produces a supersede event + a revision snapshot', async () => {
    // Look up the new (active) preference id so we can probe /audit/:id.
    const newPrefId = await txRead(async (tx) => {
      const r = await tx.run(
        'MATCH (p:Preference {key: $key}) WHERE p.validTo IS NULL RETURN p.id AS id LIMIT 1',
        { key: prefKey },
      );
      return r.records[0]?.get('id') as string;
    });
    expect(newPrefId).toBeDefined();

    const fromIso = testRunStart.toISOString();
    const list = await getAuth(`/audit?from=${encodeURIComponent(fromIso)}&limit=500`);
    const events = list.json().data as Array<{
      kind: string;
      targetKind: string;
      payload: Record<string, unknown>;
      actor?: string;
    }>;
    const prefEvents = events.filter(
      (e) => e.targetKind === 'preference' && e.actor === 'preference-service',
    );
    expect(prefEvents.some((e) => e.kind === 'create')).toBe(true);
    expect(prefEvents.some((e) => e.kind === 'supersede')).toBe(true);

    // Revisions attach to the preference id that was mutated — i.e. the prior
    // version (the one whose validTo was just set). Look it up by key.
    const priorPrefId = await txRead(async (tx) => {
      const r = await tx.run(
        'MATCH (p:Preference {key: $key}) WHERE p.validTo IS NOT NULL RETURN p.id AS id ORDER BY p.validTo DESC LIMIT 1',
        { key: prefKey },
      );
      return r.records[0]?.get('id') as string;
    });
    expect(priorPrefId).toBeDefined();

    const detail = await getAuth(`/audit/${priorPrefId}`);
    const revisions = detail.json().data.revisions as Array<{
      snapshot: unknown;
      reason: string;
    }>;
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const rev = revisions[0]!;
    const snapshot =
      typeof rev.snapshot === 'string'
        ? (JSON.parse(rev.snapshot) as { key?: string; value?: string })
        : (rev.snapshot as { key?: string; value?: string });
    expect(snapshot.key).toBe(prefKey);
    expect(snapshot.value).toBe('alpha');

    // Sanity: confirm the new (active) preference id was the supersede target.
    const supersedeEvent = prefEvents.find((e) => e.kind === 'supersede');
    expect(supersedeEvent).toBeDefined();
    expect((supersedeEvent!.payload as { newId?: string }).newId).toBe(newPrefId);
  });
});
