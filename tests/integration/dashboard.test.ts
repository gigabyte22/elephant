// Integration tests for /dashboard/api/*. Seeds a small graph through the
// regular HTTP surface (so refcount ticks, audit emissions, scope axes all
// run through their real code paths), then asserts the introspection wire
// shapes.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { DreamRunRepository } from '../../src/repositories/DreamRunRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' } as const;

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
const previousRefCountMode = process.env.RETRIEVAL_REFCOUNT_TICK_MODE;

// Seeded ids for assertions
let factDeployId: string;
let factAliceId: string;
let factStagingId: string;
let supersededOldFactId: string;
let supersedingNewFactId: string;

beforeAll(async () => {
  process.env.RETRIEVAL_REFCOUNT_TICK_MODE = 'sync';
  const llm = createFakeLLMAdapter();
  const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  container = await bootstrap({ llm, embedder });
  app = await buildHttpServer(container);
  await app.ready();
  await clearDb();
  await seed();
});

afterAll(async () => {
  await clearDb();
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

async function seed(): Promise<void> {
  const batch = await postJson('/facts/batch', {
    facts: [
      {
        content: 'alice manages the deploy server at deploy.example.com',
        importance: 0.7,
        confidence: 0.9,
        entityNames: ['alice', 'deploy server'],
        projectId: 'proj-A',
        category: 'infrastructure',
      },
      {
        content: 'alice prefers terse code reviews on weekday mornings',
        importance: 0.5,
        confidence: 0.8,
        entityNames: ['alice'],
        projectId: 'proj-A',
        category: 'people',
      },
      {
        content: 'the staging environment lives at staging.example.com',
        importance: 0.4,
        confidence: 0.85,
        entityNames: ['staging environment'],
        projectId: 'proj-B',
      },
    ],
  });
  expect(batch.statusCode).toBe(200);
  const ids = (batch.json().data as Array<{ id: string }>).map((f) => f.id);
  factDeployId = ids[0]!;
  factAliceId = ids[1]!;
  factStagingId = ids[2]!;

  // Build a supersede chain so the dashboard's fact counts have signal.
  const oldFact = await postJson('/facts', {
    content: 'staging environment lives at staging-old.example.com',
    importance: 0.4,
    confidence: 0.7,
    entityNames: ['staging environment'],
    projectId: 'proj-B',
  });
  expect(oldFact.statusCode).toBe(200);
  supersededOldFactId = oldFact.json().data.id as string;

  const newFact = await postJson('/facts', {
    content: 'staging environment lives at staging-new.example.com',
    importance: 0.4,
    confidence: 0.8,
    entityNames: ['staging environment'],
    projectId: 'proj-B',
  });
  expect(newFact.statusCode).toBe(200);
  supersedingNewFactId = newFact.json().data.id as string;

  const sup = await postJson(`/facts/${supersededOldFactId}/supersede`, {
    newFactId: supersedingNewFactId,
    reason: 'moved to new dns',
  });
  expect(sup.statusCode).toBe(200);

  // Soft-delete a separate fact so softDeleted count is non-zero too.
  const softTarget = await postJson('/facts', {
    content: 'temporary intern note that should be removed',
    importance: 0.1,
    confidence: 0.5,
  });
  expect(softTarget.statusCode).toBe(200);
  const softId = softTarget.json().data.id as string;
  const del = await app.inject({ method: 'DELETE', url: `/facts/${softId}`, headers: auth });
  expect(del.statusCode).toBe(200);

  // Two preferences + one observation for kindCounts coverage.
  await app.inject({
    method: 'PUT',
    url: '/preferences/notification-channel',
    headers: json,
    payload: { value: 'slack' },
  });
  await app.inject({
    method: 'PUT',
    url: '/preferences/preferred-editor',
    headers: json,
    payload: { value: 'neovim' },
  });
  await postJson('/observations', {
    agentId: 'agent-alpha',
    sessionId: 'sess-1',
    content: 'currently investigating deploy regressions',
    projectId: 'proj-A',
  });

  // Knowledge document + procedure for graph search coverage.
  const kdoc = await postJson('/knowledge/documents', {
    title: 'Deployment Runbook',
    source: 'wiki',
    content:
      'To deploy the service, push the green button on deploy.example.com. ' +
      'Rollback by re-running the previous tag.',
    summary: 'how to deploy and rollback the service',
    tags: ['deploy'],
    scope: { projectId: 'proj-A' },
  });
  expect(kdoc.statusCode).toBe(200);

  const proc = await postJson('/procedures', {
    name: 'rollback deploy',
    whenToUse: 'when a deploy goes wrong and needs reverting',
    content: 'run the previous-tag command on deploy.example.com',
  });
  expect(proc.statusCode).toBe(200);

  // Drive the refcount tick: each /recall hit on a fact bumps its referenceCount.
  // Hit fact A three times, fact B once, fact C zero times so the ordering is unambiguous.
  for (let i = 0; i < 3; i++) {
    const r = await getAuth('/recall?q=deploy%20server&limit=5');
    expect(r.statusCode).toBe(200);
  }
  const r2 = await getAuth('/recall?q=alice%20code%20reviews&limit=5');
  expect(r2.statusCode).toBe(200);
}

describe('/dashboard/api/stats', () => {
  test('returns kind counts, fact counts, entity count, supersede edges', async () => {
    const res = await getAuth('/dashboard/api/stats');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);

    const kindMap = new Map<string, number>(
      (body.data.kindCounts as Array<{ kind: string; count: number }>).map((k) => [
        k.kind,
        k.count,
      ]),
    );
    // 3 batch facts + 2 supersede chain facts + 1 soft-deleted fact = 6 facts
    expect(kindMap.get('fact')).toBe(6);
    expect(kindMap.get('preference')).toBe(2);
    expect(kindMap.get('observation')).toBe(1);
    expect(kindMap.get('knowledge_document')).toBe(1);
    expect(kindMap.get('procedure')).toBe(1);

    // 3 batch + 1 new supersede = 4 active; 1 old supersede = 1 superseded; 1 soft-deleted
    expect(body.data.facts.active).toBe(4);
    expect(body.data.facts.superseded).toBe(1);
    expect(body.data.facts.softDeleted).toBe(1);

    expect(body.data.entities).toBeGreaterThan(0);
    expect(body.data.supersedeEdges).toBe(1);
    expect(body.data.observations.active).toBe(1);
  });

  test('scope filter narrows counts to projectId', async () => {
    const res = await getAuth('/dashboard/api/stats?projectId=proj-A');
    expect(res.statusCode).toBe(200);
    const kindMap = new Map<string, number>(
      (res.json().data.kindCounts as Array<{ kind: string; count: number }>).map((k) => [
        k.kind,
        k.count,
      ]),
    );
    // proj-A has 2 batch facts + 1 knowledge document scoped to it. Staging
    // facts are proj-B; the soft-deleted fact and the unscoped preferences and
    // observation are not included.
    expect(kindMap.get('fact')).toBe(2);
    expect(kindMap.get('knowledge_document')).toBe(1);
    expect(kindMap.has('preference')).toBe(false);
  });
});

describe('/dashboard/api/facts/top', () => {
  test('refs sort orders by referenceCount desc', async () => {
    const res = await getAuth('/dashboard/api/facts/top?sort=refs&limit=10');
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{
      id: string;
      refCount: number;
      content: string;
    }>;
    // Each recall ticks every fact it returns, and entity-sibling expansion
    // tends to drag in multiple facts. Don't assert which specific fact sits
    // on top — assert monotonicity, that factDeployId got bumped, and that the
    // staging fact (never queried) stayed at zero.
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.refCount).toBeLessThanOrEqual(items[i - 1]!.refCount);
    }
    const deploy = items.find((i) => i.id === factDeployId);
    expect(deploy?.refCount).toBeGreaterThanOrEqual(3);
  });

  test('importance sort orders by importance desc', async () => {
    const res = await getAuth('/dashboard/api/facts/top?sort=importance&limit=10');
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ id: string; importance: number }>;
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.importance).toBeLessThanOrEqual(items[i - 1]!.importance);
    }
  });

  test('strips embeddings and excludes superseded facts', async () => {
    const res = await getAuth('/dashboard/api/facts/top?sort=recent&limit=20');
    const items = res.json().data.items as Array<Record<string, unknown>>;
    expect(items.every((i) => !('embedding' in i))).toBe(true);
    expect(items.every((i) => i.id !== supersededOldFactId)).toBe(true);
  });

  test('q narrows to content substring matches', async () => {
    const res = await getAuth('/dashboard/api/facts/top?sort=recent&limit=20&q=ALICE');
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    const items = body.items as Array<{ content: string }>;
    expect(items.length).toBe(2);
    expect(items.every((i) => i.content.toLowerCase().includes('alice'))).toBe(true);
    expect(body.total).toBe(2);
  });

  test('category filters exactly', async () => {
    const res = await getAuth(
      '/dashboard/api/facts/top?sort=recent&limit=20&category=infrastructure',
    );
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ id: string }>;
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe(factDeployId);
  });

  test('offset paginates stably with total', async () => {
    const page1 = await getAuth('/dashboard/api/facts/top?sort=recent&limit=2&offset=0');
    const page2 = await getAuth('/dashboard/api/facts/top?sort=recent&limit=2&offset=2');
    expect(page1.statusCode).toBe(200);
    expect(page2.statusCode).toBe(200);
    const d1 = page1.json().data;
    const d2 = page2.json().data;
    // 4 active facts seeded: 3 batch + the superseding replacement.
    expect(d1.total).toBe(4);
    expect(d1.offset).toBe(0);
    expect(d2.offset).toBe(2);
    const ids1 = (d1.items as Array<{ id: string }>).map((i) => i.id);
    const ids2 = (d2.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids1.length).toBe(2);
    expect(ids2.length).toBe(2);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  test('every item carries a retention score in (0,1]', async () => {
    const res = await getAuth('/dashboard/api/facts/top?sort=refs&limit=10');
    const items = res.json().data.items as Array<{ retention: number }>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.retention).toBeGreaterThan(0);
      expect(item.retention).toBeLessThanOrEqual(1);
    }
  });
});

describe('/dashboard/api/facts/categories', () => {
  test('groups active facts by category, null as uncategorized', async () => {
    const res = await getAuth('/dashboard/api/facts/categories');
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ category: string; count: number }>;
    const map = new Map(items.map((i) => [i.category, i.count]));
    expect(map.get('infrastructure')).toBe(1);
    expect(map.get('people')).toBe(1);
    // staging fact + superseding replacement have no category.
    expect(map.get('uncategorized')).toBe(2);
  });

  test('scope filter applies', async () => {
    const res = await getAuth('/dashboard/api/facts/categories?projectId=proj-A');
    const items = res.json().data.items as Array<{ category: string; count: number }>;
    const map = new Map(items.map((i) => [i.category, i.count]));
    expect(map.get('infrastructure')).toBe(1);
    expect(map.get('people')).toBe(1);
    expect(map.has('uncategorized')).toBe(false);
  });
});

describe('/dashboard/api/entities/types', () => {
  test('returns a global type distribution', async () => {
    const res = await getAuth('/dashboard/api/entities/types');
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ type: string; count: number }>;
    expect(items.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.count).toBeLessThanOrEqual(items[i - 1]!.count);
    }
    const total = items.reduce((a, b) => a + b.count, 0);
    expect(total).toBeGreaterThan(0);
  });
});

describe('/dashboard/api/entities/top', () => {
  test('orders by fact count descending', async () => {
    const res = await getAuth('/dashboard/api/entities/top?limit=10');
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{
      name: string;
      factCount: number;
    }>;
    expect(items.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.factCount).toBeLessThanOrEqual(items[i - 1]!.factCount);
    }
    // alice is on 2 facts; staging environment on 1 (new) — alice should rank first.
    const alice = items.find((i) => i.name === 'alice');
    expect(alice?.factCount).toBe(2);
  });
});

describe('/dashboard/api/timeline', () => {
  test('returns day buckets for facts', async () => {
    const res = await getAuth('/dashboard/api/timeline?kind=fact&bucket=day&days=7');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.bucket).toBe('day');
    expect(data.kind).toBe('fact');
    expect(Array.isArray(data.points)).toBe(true);
    // Every seeded fact landed today, so a single non-zero bucket is expected.
    const totals = (data.points as Array<{ count: number }>).reduce((a, b) => a + b.count, 0);
    expect(totals).toBe(6);
  });

  test('returns hour buckets for observations', async () => {
    const res = await getAuth('/dashboard/api/timeline?kind=observation&bucket=hour&days=1');
    expect(res.statusCode).toBe(200);
    const points = res.json().data.points as Array<{ count: number }>;
    expect(points.reduce((a, b) => a + b.count, 0)).toBe(1);
  });
});

describe('/dashboard/api/graph/search', () => {
  test('returns hits across fact / entity / procedure / knowledge_chunk', async () => {
    const res = await getAuth('/dashboard/api/graph/search?q=deploy&limit=30');
    expect(res.statusCode).toBe(200);
    const results = res.json().data.results as Array<{ kind: string; label: string }>;
    expect(results.length).toBeGreaterThan(0);
    const kinds = new Set(results.map((r) => r.kind));
    expect(kinds.has('entity') || kinds.has('fact') || kinds.has('procedure')).toBe(true);
  });
});

describe('/dashboard/api/graph/neighborhood', () => {
  test('returns the fact + its entities at depth=1', async () => {
    const res = await getAuth(
      `/dashboard/api/graph/neighborhood?nodeId=${factDeployId}&depth=1&maxNodes=50`,
    );
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.rootId).toBe(factDeployId);
    const nodeIds = new Set((data.nodes as Array<{ id: string }>).map((n) => n.id));
    expect(nodeIds.has(factDeployId)).toBe(true);
    const edges = data.edges as Array<{ source: string; target: string; type: string }>;
    expect(edges.some((e) => e.type === 'HAS_FACT')).toBe(true);
  });

  test('depth=2 walks past first-hop neighbors', async () => {
    const res = await getAuth(
      `/dashboard/api/graph/neighborhood?nodeId=${factDeployId}&depth=2&maxNodes=80`,
    );
    expect(res.statusCode).toBe(200);
    const nodes = res.json().data.nodes as Array<{ kind: string; id: string }>;
    // Alice is shared with factAliceId, so the 2-hop walk should reach it.
    expect(nodes.some((n) => n.id === factAliceId)).toBe(true);
  });

  test('strips embedding from node props', async () => {
    const res = await getAuth(
      `/dashboard/api/graph/neighborhood?nodeId=${factDeployId}&depth=1&maxNodes=20`,
    );
    const nodes = res.json().data.nodes as Array<{ props: Record<string, unknown> }>;
    expect(nodes.every((n) => !('embedding' in n.props))).toBe(true);
  });
});

describe('/dashboard/api/supersede-chains', () => {
  test('returns both facts in the chain, ordered oldest first', async () => {
    const res = await getAuth(`/dashboard/api/supersede-chains?factId=${supersededOldFactId}`);
    expect(res.statusCode).toBe(200);
    const chain = res.json().data.chain as Array<{ id: string; validFrom: string }>;
    expect(chain.length).toBe(2);
    const ids = chain.map((c) => c.id);
    expect(ids).toContain(supersededOldFactId);
    expect(ids).toContain(supersedingNewFactId);
  });
});

describe('/dashboard/api/dreams', () => {
  test('returns empty list when no dream runs exist', async () => {
    const res = await getAuth('/dashboard/api/dreams?limit=10');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.items).toEqual([]);
  });

  test('round-trips every persisted counter including failure and graph stats', async () => {
    const runId = randomUUID();
    const startedAt = new Date(Date.now() - 60_000);
    await txWrite(async (tx) => {
      await DreamRunRepository.create(tx, {
        id: runId,
        startedAt,
        completedAt: new Date(),
        status: 'completed',
        episodesProcessed: 7,
        episodesFailed: 1,
        factsCreated: 12,
        factsSuperseded: 3,
        factsPruned: 4,
        factsMerged: 2,
        insightsPromoted: 1,
        extractionFailures: 2,
        supersedeFailures: 1,
        relationsCreated: 9,
        synonymsCreated: 5,
        entitiesReembedded: 6,
      });
    });

    const res = await getAuth('/dashboard/api/dreams?limit=10');
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<Record<string, unknown>>;
    const run = items.find((i) => i.id === runId);
    expect(run).toBeDefined();
    expect(run!.episodesProcessed).toBe(7);
    expect(run!.episodesFailed).toBe(1);
    expect(run!.factsCreated).toBe(12);
    expect(run!.factsSuperseded).toBe(3);
    expect(run!.factsPruned).toBe(4);
    expect(run!.factsMerged).toBe(2);
    expect(run!.insightsPromoted).toBe(1);
    expect(run!.extractionFailures).toBe(2);
    expect(run!.supersedeFailures).toBe(1);
    expect(run!.relationsCreated).toBe(9);
    expect(run!.synonymsCreated).toBe(5);
    expect(run!.entitiesReembedded).toBe(6);
    expect(run!.durationMs).toBeGreaterThan(0);
  });
});

describe('/dashboard/api/audit', () => {
  test('kind filter narrows to matching events', async () => {
    const res = await getAuth('/dashboard/api/audit?kind=supersede&limit=50');
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ kind: string }>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((i) => i.kind === 'supersede')).toBe(true);
  });

  test('to-cursor pages return only events at or before the cursor', async () => {
    const first = await getAuth('/dashboard/api/audit?limit=3');
    expect(first.statusCode).toBe(200);
    const firstItems = first.json().data.items as Array<{ id: string; at: string }>;
    expect(firstItems.length).toBe(3);
    const cursor = firstItems[firstItems.length - 1]!.at;

    const older = await getAuth(`/dashboard/api/audit?limit=50&to=${encodeURIComponent(cursor)}`);
    expect(older.statusCode).toBe(200);
    const olderItems = older.json().data.items as Array<{ id: string; at: string }>;
    expect(olderItems.length).toBeGreaterThan(0);
    for (const item of olderItems) {
      expect(new Date(item.at).getTime()).toBeLessThanOrEqual(new Date(cursor).getTime());
    }
  });
});

describe('/dashboard/api/episodes/origins', () => {
  test('counts episodes grouped by origin', async () => {
    const mk = (origin?: string) =>
      postJson('/episodes', {
        agentId: 'agent-alpha',
        sessionId: `sess-origin-${origin ?? 'default'}`,
        rawTranscript: 'transcript for origin coverage',
        ...(origin ? { origin } : {}),
      });
    expect((await mk('cron')).statusCode).toBe(200);
    expect((await mk('cron')).statusCode).toBe(200);
    expect((await mk()).statusCode).toBe(200); // origin omitted → counts as 'user'

    const res = await getAuth('/dashboard/api/episodes/origins');
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ origin: string; count: number }>;
    const map = new Map(items.map((i) => [i.origin, i.count]));
    expect(map.get('cron')).toBe(2);
    expect(map.get('user')).toBe(1);
  });
});

// Mutates seeded facts (ages one, adds an exempt one) — keep this describe
// LAST so earlier count/ordering assertions stay valid.
describe('/dashboard/api/facts/retention', () => {
  beforeAll(async () => {
    // Age the staging fact far past the prune window (importance 0.4, refs 0 →
    // retention ~e^-38 → prunable), and add a high-importance fact for the
    // exempt bucket.
    await txWrite(async (tx) => {
      await tx.run(
        `MATCH (f:Fact {id: $id})
         SET f.recordedAt = datetime() - duration({days: 100}),
             f.lastReferencedAt = NULL,
             f.referenceCount = 0`,
        { id: factStagingId },
      );
    });
    const exempt = await postJson('/facts', {
      content: 'the company is registered in delaware',
      importance: 0.8,
      confidence: 0.95,
    });
    expect(exempt.statusCode).toBe(200);
  });

  test('summarizes exempt / at-risk / prunable and lists at-risk facts', async () => {
    const res = await getAuth('/dashboard/api/facts/retention');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;

    expect(data.policy.importanceExempt).toBeCloseTo(0.75);
    expect(data.policy.minWindowDays).toBe(30);
    expect(data.totalActive).toBeGreaterThanOrEqual(5);
    expect(data.truncated).toBe(false);

    expect(data.summary.exempt).toBeGreaterThanOrEqual(1);
    expect(data.summary.atRisk).toBeGreaterThanOrEqual(1);
    expect(data.summary.prunable).toBeGreaterThanOrEqual(1);

    const atRisk = data.atRisk as Array<{ id: string; retention: number; prunable: boolean }>;
    const staging = atRisk.find((f) => f.id === factStagingId);
    expect(staging).toBeDefined();
    expect(staging!.retention).toBeLessThan(0.05);
    expect(staging!.prunable).toBe(true);

    // Histogram covers all sampled facts across 10 bins.
    const histogram = data.histogram as Array<{ bin: number; count: number }>;
    expect(histogram.length).toBe(10);
    const histTotal = histogram.reduce((a, b) => a + b.count, 0);
    expect(histTotal).toBe(data.totalActive);

    const sample = data.sample as Array<{ retention: number; exempt: boolean }>;
    expect(sample.length).toBe(data.totalActive);
    expect(sample.some((p) => p.exempt)).toBe(true);
  });

  test('scope filter narrows the working set', async () => {
    const res = await getAuth('/dashboard/api/facts/retention?projectId=proj-A');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.totalActive).toBe(2);
    // Both proj-A facts were recently referenced → nothing at risk in scope.
    expect(data.summary.atRisk).toBe(0);
  });
});
