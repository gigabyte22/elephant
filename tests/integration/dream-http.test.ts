// HTTP-level dream coverage: trigger → poll → concurrent-trigger 409, plus the
// stale-run reaper. Everything here was previously untested at the route layer,
// which is how the cron's unhandled DreamInProgressError (a process-killer)
// survived — the 409 path only ever ran in production.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import type { LLMAdapter } from '../../src/adapters/llm/types.ts';
import { read as txRead, write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { DreamRunRepository } from '../../src/repositories/DreamRunRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };

// Lets a test hold the dream cycle open inside extractFacts, so the second
// trigger is guaranteed to land while the mutex is genuinely held.
interface Gate {
  opened: Promise<void>;
  release: () => void;
  entered: boolean;
}
let activeGate: Gate | null = null;

function makeGate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release, entered: false };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  const base = createFakeLLMAdapter({
    extract: () => [
      {
        content: 'the operator restarted the service',
        category: 'event',
        confidence: 0.9,
        importance: 0.5,
        entityNames: ['operator'],
      },
    ],
  });
  const llm: LLMAdapter = {
    ...base,
    async extractFacts(input) {
      if (activeGate) {
        activeGate.entered = true;
        await activeGate.opened;
      }
      return base.extractFacts(input);
    },
  };
  const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  container = await bootstrap({ llm, embedder });
  app = await buildHttpServer(container);
  await app.ready();
});

afterAll(async () => {
  activeGate?.release();
  await app?.close();
  await shutdown();
});

async function clearDb(): Promise<void> {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
}

// Wait for the cycle mutex to actually be free. Polling the run's status is not
// enough: finalise() flips the record to 'completed' inside the try, and the
// mutex is only released by the finally that follows — so a test that waits on
// status alone can still race the next trigger into a 409.
async function drainDream(): Promise<void> {
  await waitUntil(async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    return res.json().data.dream.running === false;
  });
}

async function seedEpisode(): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/episodes',
    headers: auth,
    payload: {
      rawTranscript: 'The operator restarted the service at 3am.',
      agentId: 'a1',
      sessionId: 's1',
    },
  });
  expect(res.statusCode).toBe(200);
}

describe('dream HTTP surface', () => {
  test('POST /dream returns a jobId and GET /dream/:jobId reports it', async () => {
    await clearDb();
    await seedEpisode();

    const res = await app.inject({ method: 'POST', url: '/dream', headers: auth });
    expect(res.statusCode).toBe(200);
    const { jobId } = res.json().data;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

    const status = await app.inject({ method: 'GET', url: `/dream/${jobId}`, headers: auth });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ ok: true, data: { id: jobId } });

    // Drain so the mutex is free for the next test.
    await drainDream();
  });

  test('GET /dream/:jobId 404s for an unknown run', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dream/00000000-0000-4000-8000-000000000000',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().ok).toBe(false);
  });

  // The path the cron hits. Must be a clean 409 naming the running job — not a
  // throw that escapes into an unhandled rejection.
  test('POST /dream while a cycle is in flight returns 409 naming the running job', async () => {
    await clearDb();
    await seedEpisode();

    const gate = makeGate();
    activeGate = gate;
    let jobId: string;
    try {
      const first = await app.inject({ method: 'POST', url: '/dream', headers: auth });
      expect(first.statusCode).toBe(200);
      jobId = first.json().data.jobId;

      // Once extractFacts is entered the cycle holds the mutex and has set
      // runningJobId, so the 409 below is deterministic rather than racing
      // trigger()'s two awaits.
      await waitUntil(() => gate.entered);

      const second = await app.inject({ method: 'POST', url: '/dream', headers: auth });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ ok: false });
      expect(second.json().error).toContain(jobId);
    } finally {
      activeGate = null;
      gate.release();
    }

    await drainDream();
  });

  // The orphan. trigger()'s fast-fail guard reads runningJobId, which runCycle
  // only sets once it has the mutex — two awaits later. Two triggers in the
  // same tick therefore both get past the guard, both write a DreamRun row, and
  // one then loses inside runCycle. That loser used to return early from the
  // catch, stranding its row at 'running' forever.
  test('a run that loses the start race is closed out, not left at running', async () => {
    await clearDb();
    await seedEpisode();

    const gate = makeGate();
    activeGate = gate;
    try {
      const ids = [container.dreaming.trigger().jobId, container.dreaming.trigger().jobId];
      expect(new Set(ids).size).toBe(2);

      await waitUntil(() => gate.entered);
      activeGate = null;
      gate.release();
      await drainDream();

      const loadAll = async () =>
        Promise.all(ids.map((id) => txRead((tx) => DreamRunRepository.get(tx, id))));

      await waitUntil(async () =>
        (await loadAll()).every((r) => r !== null && r.status !== 'running'),
      );

      const runs = await loadAll();
      const failed = runs.filter((r) => r?.status === 'failed');
      expect(runs.filter((r) => r?.status === 'completed')).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.error).toContain('already in progress');
    } finally {
      activeGate = null;
      gate.release();
    }
  });

  test('failStaleRunning closes out runs abandoned by a crash', async () => {
    await clearDb();
    const old = new Date(Date.now() - 6 * 60 * 60_000);
    await txWrite(async (tx) => {
      await tx.run(
        `CREATE (:DreamRun {id: $id, startedAt: datetime($at), status: 'running',
           episodesProcessed: 0, episodesFailed: 0, factsCreated: 0, factsSuperseded: 0,
           factsPruned: 0, factsMerged: 0, insightsPromoted: 0, extractionFailures: 0,
           supersedeFailures: 0, relationsCreated: 0, synonymsCreated: 0,
           entitiesReembedded: 0})`,
        { id: 'aaaaaaaa-0000-4000-8000-000000000001', at: old.toISOString() },
      );
    });

    const reaped = await txWrite((tx) =>
      DreamRunRepository.failStaleRunning(tx, new Date(Date.now() - 60 * 60_000)),
    );
    expect(reaped).toBe(1);

    const run = await txRead((tx) =>
      DreamRunRepository.get(tx, 'aaaaaaaa-0000-4000-8000-000000000001'),
    );
    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('abandoned');
  });

  test('failStaleRunning leaves a freshly-started run alone', async () => {
    await clearDb();
    await txWrite(async (tx) => {
      await tx.run(
        `CREATE (:DreamRun {id: $id, startedAt: datetime(), status: 'running',
           episodesProcessed: 0, episodesFailed: 0, factsCreated: 0, factsSuperseded: 0,
           factsPruned: 0, factsMerged: 0, insightsPromoted: 0, extractionFailures: 0,
           supersedeFailures: 0, relationsCreated: 0, synonymsCreated: 0,
           entitiesReembedded: 0})`,
        { id: 'aaaaaaaa-0000-4000-8000-000000000002' },
      );
    });

    const reaped = await txWrite((tx) =>
      DreamRunRepository.failStaleRunning(tx, new Date(Date.now() - 60 * 60_000)),
    );
    expect(reaped).toBe(0);
  });
});
