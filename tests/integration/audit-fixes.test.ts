// Integration coverage for the audit-driven repairs:
//   - confidenceDelta from the LLM supersede check is applied to the new fact
//   - entity identity is case/whitespace-folded (no duplicate Alice/alice nodes)
//   - the graph overview honours excludeKinds (Option A hides raw layers)
// Runs against the testcontainer Neo4j + fake adapters; wipes data on teardown.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read as txRead, write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' } as const;

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
const previousRefCountMode = process.env.RETRIEVAL_REFCOUNT_TICK_MODE;

beforeAll(async () => {
  process.env.RETRIEVAL_REFCOUNT_TICK_MODE = 'sync';

  // Supersede only fires for the dedicated confidence test (content carries the
  // 'lumos' sentinel) so it never disturbs the entity / overview fixtures. The
  // 'beta' rollout replaces the 'alpha' one — directional, because the sweep
  // checks every unchecked fact and a symmetric judge would have the older one
  // supersede the newer depending on which was examined first. When it fires it
  // bumps the new fact's confidence by +0.3.
  const llm = createFakeLLMAdapter({
    supersede: ({ candidate, existing }) => {
      if (!candidate.content.includes('lumos beta')) return null;
      const alpha = existing.find((e) => e.content.includes('lumos alpha'));
      return alpha
        ? { oldFactId: alpha.id, reason: 'newer rollout wins', confidenceDelta: 0.3 }
        : null;
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

/** Backdate every unchecked fact past the supersede sweep's settling window,
 *  which otherwise leaves just-written facts for the following cycle. */
async function settleForSweep(): Promise<void> {
  await txWrite((tx) =>
    tx.run(
      `MATCH (f:Fact) WHERE f.supersedeCheckedAt IS NULL
       SET f.recordedAt = datetime() - duration({minutes: 5})`,
    ),
  );
}

type Response = Awaited<ReturnType<typeof app.inject>>;
function postJson(url: string, payload: unknown): Promise<Response> {
  return app.inject({ method: 'POST', url, headers: json, payload: payload as object });
}
function getAuth(url: string): Promise<Response> {
  return app.inject({ method: 'GET', url, headers: auth });
}

describe('confidenceDelta applied on supersede', () => {
  test('new fact confidence is adjusted by the LLM delta', async () => {
    await clearDb();

    // A and B share almost all tokens (cosine ≥ 0.85) so B's supersede check
    // finds A as a candidate. Both carry the 'lumos' sentinel.
    const a = await postJson('/facts', {
      content:
        'lumos alpha deploy production service blue green strategy friday afternoon rollout window',
      confidence: 0.9,
      importance: 0.6,
    });
    expect(a.statusCode).toBe(200);
    const aId = a.json().data.id as string;

    const b = await postJson('/facts', {
      content:
        'lumos beta deploy production service blue green strategy friday afternoon rollout window',
      confidence: 0.5,
      importance: 0.6,
    });
    expect(b.statusCode).toBe(200);
    const bId = b.json().data.id as string;

    // The check that applies the delta runs in the dream cycle now, not in the
    // write — POST /facts returns without an LLM call. Backdating past the
    // sweep's settling window is what makes these facts claimable this cycle.
    await settleForSweep();
    await container.dreaming.runCycle();

    const rows = await txRead(async (tx) => {
      const res = await tx.run(
        `MATCH (newF:Fact {id: $bId})
         OPTIONAL MATCH (oldF:Fact {id: $aId})
         OPTIONAL MATCH (newF)-[r:SUPERSEDES]->(oldF)
         RETURN newF.confidence AS newConf, oldF.validTo AS oldValidTo, r IS NOT NULL AS hasEdge`,
        { aId, bId },
      );
      const rec = res.records[0]!;
      return {
        newConf: rec.get('newConf') as number,
        oldValidTo: rec.get('oldValidTo'),
        hasEdge: rec.get('hasEdge') as boolean,
      };
    });

    expect(rows.hasEdge).toBe(true); // B supersedes A
    expect(rows.oldValidTo).not.toBeNull(); // A retired
    expect(rows.newConf).toBeCloseTo(0.8, 5); // 0.5 + 0.3 delta
  });

  test('audit event records the delta and resulting confidence', async () => {
    // Actor is 'dreamer' rather than 'memory-ingest': the supersede decision is
    // the dream cycle's now, and the audit trail says so.
    const audit = await getAuth('/audit?actor=dreamer');
    expect(audit.statusCode).toBe(200);
    const events = audit.json().data as Array<{ kind: string; payload: Record<string, unknown> }>;
    const supersede = events.find((e) => e.kind === 'supersede');
    expect(supersede).toBeDefined();
    expect(supersede!.payload.confidenceDelta).toBeCloseTo(0.3, 5);
    expect(supersede!.payload.newConfidence).toBeCloseTo(0.8, 5);
  });
});

describe('entity identity is case/whitespace-folded', () => {
  test('Alice / alice / "Alice " collapse onto one entity holding all facts', async () => {
    await clearDb();

    await postJson('/facts', { content: 'fact one about a person', entityNames: ['Alice'] });
    await postJson('/facts', { content: 'fact two about a person', entityNames: ['alice'] });
    await postJson('/facts', { content: 'fact three about a person', entityNames: ['Alice '] });

    const result = await txRead(async (tx) => {
      const res = await tx.run(
        `MATCH (e:Entity {nameNorm: 'alice'})
         OPTIONAL MATCH (e)-[:HAS_FACT]->(f:Fact)
         RETURN count(DISTINCT e) AS entityCount, count(DISTINCT f) AS factCount`,
      );
      const rec = res.records[0]!;
      return {
        entityCount:
          (rec.get('entityCount') as { toNumber?: () => number }).toNumber?.() ??
          (rec.get('entityCount') as number),
        factCount:
          (rec.get('factCount') as { toNumber?: () => number }).toNumber?.() ??
          (rec.get('factCount') as number),
      };
    });

    expect(Number(result.entityCount)).toBe(1);
    expect(Number(result.factCount)).toBe(3);
  });
});

describe('graph overview honours excludeKinds', () => {
  beforeAll(async () => {
    await clearDb();
    await postJson('/facts', { content: 'a durable fact for the cosmos', entityNames: ['widget'] });
    await postJson('/episodes', {
      agentId: 'a',
      sessionId: 's',
      rawTranscript:
        'user: hello there assistant: hi, how can I help you today? user: testing the graph',
    });
  });

  test('default (no filter) includes raw chunk/episode layers', async () => {
    const res = await getAuth('/dashboard/api/graph/overview');
    expect(res.statusCode).toBe(200);
    const kinds = new Set((res.json().data.nodes as Array<{ kind: string }>).map((n) => n.kind));
    expect(kinds.has('chunk') || kinds.has('episode')).toBe(true);
  });

  test('excludeKinds drops raw layers but keeps the knowledge graph', async () => {
    const res = await getAuth(
      '/dashboard/api/graph/overview?excludeKinds=chunk,knowledge_chunk,episode,observation',
    );
    expect(res.statusCode).toBe(200);
    const nodes = res.json().data.nodes as Array<{ kind: string }>;
    const kinds = new Set(nodes.map((n) => n.kind));
    expect(kinds.has('chunk')).toBe(false);
    expect(kinds.has('episode')).toBe(false);
    expect(kinds.has('fact')).toBe(true);
    expect(kinds.has('entity')).toBe(true);
  });
});
