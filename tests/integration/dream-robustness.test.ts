// Verifies the dream cycle is robust against per-call failures: a single bad
// LLM call (or other transient error inside processEpisode) must not pin the
// cursor — otherwise the cron re-runs the same poisoned episode forever and
// the queue backs up.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { EmbeddingAdapter } from '../../src/adapters/embeddings/types.ts';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { JsonExtractionError } from '../../src/adapters/llm/json-prompt.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import type { ExtractedFact, Fact } from '../../src/models/types.ts';
import { DreamCursorRepository } from '../../src/repositories/DreamCursorRepository.ts';
import { FactRepository } from '../../src/repositories/FactRepository.ts';
import { newId } from '../../src/utils/ids.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };

// Mutable knobs the tests flip to inject failures into the fake adapters.
const knobs = {
  supersedeThrows: false,
  // When set, the fake supersede targets this fact id IF it appears in the
  // offered candidates — lets tests drive a real supersede through the scope
  // filters and observe which candidates survived them.
  supersedeTargetId: null as string | null,
  extractThrowsOnContains: null as string | null,
  embedderThrows: false,
  // Origin of the last episode handed to the fake extractor — asserts the
  // POST /episodes → dreamer → extractFacts provenance threading.
  lastExtractOrigin: undefined as string | undefined,
  // When set, the next embedBatch() call returns these exact embeddings
  // instead of hashing the texts. One-shot — consumed on use. Lets the
  // supersede test place a fact at a precise cosine distance from another
  // fact, dodging the dedup/supersede threshold band fiddly-ness.
  embedBatchOverride: null as number[][] | null,
};

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
let baseEmbedder: EmbeddingAdapter;

beforeAll(async () => {
  baseEmbedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  // Wrap the fake embedder so a knob can make embedBatch throw — simulates a
  // transient embedder failure inside processEpisode — or override the result.
  const embedder: EmbeddingAdapter = {
    ...baseEmbedder,
    async embedBatch(texts) {
      if (knobs.embedderThrows) throw new Error('simulated embedder failure');
      if (knobs.embedBatchOverride) {
        const out = knobs.embedBatchOverride;
        knobs.embedBatchOverride = null;
        return out;
      }
      return baseEmbedder.embedBatch(texts);
    },
  };

  const llm = createFakeLLMAdapter({
    extract: ({ episode }): ExtractedFact[] => {
      knobs.lastExtractOrigin = episode.origin;
      if (
        knobs.extractThrowsOnContains &&
        episode.rawTranscript.toLowerCase().includes(knobs.extractThrowsOnContains)
      ) {
        throw new JsonExtractionError('simulated parse failure', '{ "facts": [ broken');
      }
      // One fact per distinct keyword.
      const keywords = ['dark mode', 'berlin', 'postgres'];
      const hits = keywords.filter((k) => episode.rawTranscript.toLowerCase().includes(k));
      return hits.map((k) => ({
        content: `user mentioned ${k}`,
        category: 'attribute',
        confidence: 0.8,
        importance: 0.5,
        entityNames: [k.split(' ')[0]!],
      }));
    },
    supersede: ({ candidate, existing }) => {
      if (knobs.supersedeThrows) {
        throw new JsonExtractionError(
          'simulated supersede parse failure',
          `{ "supersedes": "abc", "reason": "truncated…`,
        );
      }
      if (knobs.supersedeTargetId && existing.some((f) => f.id === knobs.supersedeTargetId)) {
        return {
          oldFactId: knobs.supersedeTargetId,
          reason: 'test-driven supersede',
          confidenceDelta: 0,
        };
      }
      // Don't actually supersede anything by default — the test only cares
      // that the call is invoked and the error path is exercised.
      void candidate;
      return null;
    },
  });

  container = await bootstrap({ llm, embedder });
  app = await buildHttpServer(container);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await shutdown();
});

beforeEach(async () => {
  knobs.supersedeThrows = false;
  knobs.supersedeTargetId = null;
  knobs.extractThrowsOnContains = null;
  knobs.embedderThrows = false;
  knobs.lastExtractOrigin = undefined;
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

async function postEpisode(rawTranscript: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/episodes',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { agentId: 'test-agent', sessionId: 's1', rawTranscript },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.episodeId as string;
}

async function postScopedEpisode(
  rawTranscript: string,
  projectId: string,
  extra: { isolated?: boolean; userId?: string } = {},
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/episodes',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { agentId: 'test-agent', sessionId: 's1', rawTranscript, projectId, ...extra },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.episodeId as string;
}

async function listFactsByContent(needle: string): Promise<Array<{ projectId: string | null }>> {
  return read(async (tx) => {
    const r = await tx.run(
      'MATCH (f:Fact) WHERE f.content CONTAINS $needle RETURN f.projectId AS projectId',
      { needle },
    );
    return r.records.map((rec) => ({ projectId: (rec.get('projectId') as string | null) ?? null }));
  });
}

describe('dream cycle robustness', () => {
  test('detectSupersede throw → run completes, supersedeFailures > 0, cursor advances', async () => {
    // Pre-seed a fact whose embedding is engineered to land in the supersede
    // band relative to the new fact: 4 non-zero indices at 0.5 each, vs the
    // new fact's 5 non-zero indices at 1/sqrt(5). Cosine = 4·(0.5·1/√5) =
    // 2/√5 ≈ 0.894 — above SUPERSEDE_VECTOR_THRESHOLD (0.85), below
    // DEDUP_THRESHOLD (0.92). Triggers a supersede call without dedup
    // killing the new fact first.
    const preseedEmbedding = new Array<number>(EMBED_DIM).fill(0);
    for (let i = 0; i < 4; i++) preseedEmbedding[i] = 0.5;
    const newEmbedding = new Array<number>(EMBED_DIM).fill(0);
    const five = 1 / Math.sqrt(5);
    for (let i = 0; i < 5; i++) newEmbedding[i] = five;

    const now = new Date(Date.now() - 60_000); // older than the upcoming episode
    const preseeded: Fact = {
      id: newId(),
      content: 'preseeded fact for supersede test',
      category: 'attribute',
      confidence: 0.8,
      importance: 0.5,
      validFrom: now,
      validTo: null,
      recordedAt: now,
      embedding: preseedEmbedding,
      entityIds: [],
    };
    await txWrite((tx) => FactRepository.create(tx, preseeded));

    await postEpisode('the user mentioned berlin');

    // Set the override AFTER ingestion (which itself calls embedBatch for
    // chunks/summary) so the FIRST embedBatch in the dream cycle (the one
    // for the extracted fact) consumes it.
    knobs.embedBatchOverride = [newEmbedding];
    knobs.supersedeThrows = true;

    const run = await container.dreaming.runCycle();

    expect(run.status).toBe('completed');
    expect(run.episodesProcessed).toBe(1);
    expect(run.supersedeFailures).toBeGreaterThan(0);
    // No episode-level failure — the per-call catch handled it.
    expect(run.episodesFailed).toBe(0);

    // Cursor must have advanced — a follow-up run sees zero new work.
    const followup = await container.dreaming.runCycle();
    expect(followup.episodesProcessed).toBe(0);
  });

  test('extractFacts throw on one episode → other episodes still produce facts, cursor advances', async () => {
    await postEpisode('the user mentioned berlin');
    await postEpisode('this episode contains poison-word and should fail extraction');
    await postEpisode('the user prefers dark mode');

    knobs.extractThrowsOnContains = 'poison-word';

    const run = await container.dreaming.runCycle();

    expect(run.status).toBe('completed');
    expect(run.episodesProcessed).toBe(3);
    expect(run.extractionFailures).toBeGreaterThan(0);
    expect(run.factsCreated).toBeGreaterThan(0);

    // Cursor advanced past all three.
    const followup = await container.dreaming.runCycle();
    expect(followup.episodesProcessed).toBe(0);
  });

  test('dream-extracted facts inherit the source episode projectId', async () => {
    await postScopedEpisode('the user mentioned berlin', 'proj-A');

    const run = await container.dreaming.runCycle();
    expect(run.factsCreated).toBeGreaterThan(0);

    const facts = await listFactsByContent('berlin');
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) expect(f.projectId).toBe('proj-A');
  });

  test('dream dedup is confined per project — identical facts in different projects both persist', async () => {
    // proj-A learns "berlin"; proj-B then learns the identical fact. With global
    // dedup the second would be skipped (cosine ≈ 1 > DEDUP_THRESHOLD); confined
    // per project, each bucket keeps its own copy.
    await postScopedEpisode('the user mentioned berlin', 'proj-A');
    await container.dreaming.runCycle();

    await postScopedEpisode('the user mentioned berlin', 'proj-B');
    await container.dreaming.runCycle();

    const facts = await listFactsByContent('berlin');
    const projectIds = facts.map((f) => f.projectId).sort();
    expect(projectIds).toEqual(['proj-A', 'proj-B']);
  });

  test('episode origin flows from POST /episodes through to fact extraction', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/episodes',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        agentId: 'test-agent',
        sessionId: 's1',
        rawTranscript: 'USER: [CRON_TRIGGER id=x] the user mentioned berlin',
        origin: 'cron',
      },
    });
    expect(res.statusCode).toBe(200);

    await container.dreaming.runCycle();
    expect(knobs.lastExtractOrigin).toBe('cron');
  });

  test('cross-scope dedup: a project episode skips a fact already known personally', async () => {
    // Personal (unscoped) episode learns "berlin" first.
    await postEpisode('the user mentioned berlin');
    await container.dreaming.runCycle();

    // A project episode then extracts the identical fact — the widened dedup
    // bucket sees the personal copy and skips it.
    await postScopedEpisode('the user mentioned berlin', 'proj-A');
    const run = await container.dreaming.runCycle();
    expect(run.factsCreated).toBe(0);

    const facts = await listFactsByContent('berlin');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.projectId).toBeNull();
  });

  test('cross-scope dedup: isolated project episodes keep their own copy', async () => {
    await postEpisode('the user mentioned berlin');
    await container.dreaming.runCycle();

    await postScopedEpisode('the user mentioned berlin', 'proj-A', { isolated: true });
    const run = await container.dreaming.runCycle();
    expect(run.factsCreated).toBe(1);

    const projectIds = (await listFactsByContent('berlin')).map((f) => f.projectId).sort();
    expect(projectIds).toEqual([null, 'proj-A']);
  });

  test('cross-scope supersede: a project fact can supersede a contradicting personal fact', async () => {
    // Same engineered-cosine setup as the supersede-throw test: preseeded
    // personal fact at cosine ≈0.894 from the incoming project fact — inside
    // the supersede band, below dedup.
    const preseedEmbedding = new Array<number>(EMBED_DIM).fill(0);
    for (let i = 0; i < 4; i++) preseedEmbedding[i] = 0.5;
    const newEmbedding = new Array<number>(EMBED_DIM).fill(0);
    const five = 1 / Math.sqrt(5);
    for (let i = 0; i < 5; i++) newEmbedding[i] = five;

    const now = new Date(Date.now() - 60_000);
    const preseeded: Fact = {
      id: newId(),
      content: 'preseeded personal fact to be superseded',
      category: 'attribute',
      confidence: 0.8,
      importance: 0.5,
      validFrom: now,
      validTo: null,
      recordedAt: now,
      embedding: preseedEmbedding,
      entityIds: [],
    };
    await txWrite((tx) => FactRepository.create(tx, preseeded));

    await postScopedEpisode('the user mentioned berlin', 'proj-A');
    knobs.embedBatchOverride = [newEmbedding];
    knobs.supersedeTargetId = preseeded.id;

    const run = await container.dreaming.runCycle();
    expect(run.factsSuperseded).toBe(1);

    const tombstone = await read(async (tx) => {
      const r = await tx.run('MATCH (f:Fact {id: $id}) RETURN f.validTo AS validTo', {
        id: preseeded.id,
      });
      return r.records[0]?.get('validTo');
    });
    expect(tombstone).not.toBeNull();
  });

  test('ingest supersede check cannot cross into another project', async () => {
    // Preseed a fact in proj-Q lexically close to the incoming proj-P fact
    // (5 of 6 shared tokens → cosine ≈0.91, above the supersede floor).
    const now = new Date(Date.now() - 60_000);
    const preseeded: Fact = {
      id: newId(),
      content: 'alpha beta gamma delta epsilon zeta',
      category: 'attribute',
      confidence: 0.8,
      importance: 0.5,
      validFrom: now,
      validTo: null,
      recordedAt: now,
      embedding: await baseEmbedder.embed('alpha beta gamma delta epsilon zeta'),
      entityIds: [],
      projectId: 'proj-Q',
    };
    await txWrite((tx) => FactRepository.create(tx, preseeded));

    knobs.supersedeTargetId = preseeded.id;
    await container.ingestion.saveFact({
      content: 'alpha beta gamma delta epsilon',
      projectId: 'proj-P',
    });

    // The scope filter kept proj-Q out of the candidate set → still live.
    const stillLive = await read(async (tx) => {
      const r = await tx.run('MATCH (f:Fact {id: $id}) RETURN f.validTo AS validTo', {
        id: preseeded.id,
      });
      return r.records[0]?.get('validTo');
    });
    expect(stillLive).toBeNull();

    // Control: the same write against a PERSONAL preseed does supersede,
    // proving only the scope guard blocked the cross-project path.
    const personal: Fact = {
      ...preseeded,
      id: newId(),
      projectId: undefined,
    };
    await txWrite((tx) => FactRepository.create(tx, personal));
    knobs.supersedeTargetId = personal.id;
    await container.ingestion.saveFact({
      content: 'alpha beta gamma delta epsilon',
      projectId: 'proj-P',
    });
    const superseded = await read(async (tx) => {
      const r = await tx.run('MATCH (f:Fact {id: $id}) RETURN f.validTo AS validTo', {
        id: personal.id,
      });
      return r.records[0]?.get('validTo');
    });
    expect(superseded).not.toBeNull();
  });

  test('embedder throw inside processEpisode → episodesFailed, cursor still advances', async () => {
    await postEpisode('the user mentioned berlin');

    knobs.embedderThrows = true;

    const run = await container.dreaming.runCycle();

    expect(run.status).toBe('completed');
    expect(run.episodesProcessed).toBe(1);
    expect(run.episodesFailed).toBe(1);
    expect(run.factsCreated).toBe(0);

    // Critical: cursor must have moved even though the episode threw — the
    // queue must drain. Confirm via DreamCursorRepository directly.
    const cursor = await read((tx) => DreamCursorRepository.get(tx));
    expect(cursor).not.toBeNull();

    const followup = await container.dreaming.runCycle();
    expect(followup.episodesProcessed).toBe(0);
  });
});
