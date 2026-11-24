// Shutdown drain for the dream cycle. `pnpm serve` used to stop the cron, close
// the driver and exit while a cycle was mid-flight, stranding its :DreamRun row
// at 'running' until a later restart reaped it. drain() now refuses new cycles,
// lets the running one stop at its next deadline check, and fails its row if
// the grace runs out.
//
// drain() is one-way, so every test builds its own container (they share the
// driver singleton; only the dreaming service's state is per container).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import type { LLMAdapter } from '../../src/adapters/llm/types.ts';
import { read as txRead, write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { DreamRunRepository } from '../../src/repositories/DreamRunRepository.ts';
import { DreamShuttingDownError } from '../../src/services/DreamingService.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };

// Holds the cycle open inside extractFacts until released.
interface Gate {
  opened: Promise<void>;
  release: () => void;
  entered: number;
}
let activeGate: Gate | null = null;

function makeGate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release, entered: 0 };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });

function gatedLLM(): LLMAdapter {
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
  return {
    ...base,
    async extractFacts(input) {
      if (activeGate) {
        activeGate.entered += 1;
        await activeGate.opened;
      }
      return base.extractFacts(input);
    },
  };
}

async function freshContainer(): Promise<Container> {
  return bootstrap({ llm: gatedLLM(), embedder });
}

// Seeding goes through a separate container so the one under test is never
// touched by anything but the calls each test makes.
let seeder: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

beforeAll(async () => {
  seeder = await freshContainer();
  app = await buildHttpServer(seeder);
  await app.ready();
});

afterAll(async () => {
  activeGate?.release();
  await app?.close();
  await shutdown();
});

beforeEach(async () => {
  activeGate = null;
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

async function seedEpisode(text: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/episodes',
    headers: auth,
    payload: { rawTranscript: text, agentId: 'a1', sessionId: 's1' },
  });
  expect(res.statusCode).toBe(200);
}

async function storedRun(id: string) {
  return txRead((tx) => DreamRunRepository.get(tx, id));
}

describe('dream drain on shutdown', () => {
  test('a cycle that outlasts the grace is recorded as interrupted', async () => {
    const container = await freshContainer();
    await seedEpisode('The operator restarted the service at 3am.');
    const gate = makeGate();
    activeGate = gate;
    try {
      const { jobId } = container.dreaming.trigger();
      await waitUntil(() => gate.entered > 0);

      const t0 = Date.now();
      await container.dreaming.drain(200);
      expect(Date.now() - t0).toBeLessThan(2_000);

      const run = await storedRun(jobId);
      expect(run?.status).toBe('failed');
      expect(run?.error).toContain('interrupted by shutdown');
      expect((await container.dreaming.status(jobId))?.status).toBe('failed');
    } finally {
      activeGate = null;
      gate.release();
    }
    // Let the abandoned cycle wind down before the next test wipes the graph.
    await waitUntil(() => container.dreaming.currentRunningJobId() === null);
  });

  test('a cycle that stops within the grace completes early', async () => {
    const container = await freshContainer();
    await seedEpisode('The operator restarted the service at 3am.');
    await seedEpisode('The operator restarted the service again at 4am.');
    const gate = makeGate();
    activeGate = gate;
    let jobId: string;
    try {
      jobId = container.dreaming.trigger().jobId;
      await waitUntil(() => gate.entered > 0);

      const drained = container.dreaming.drain(10_000);
      // The stop flag is set before the gated episode finishes, so the cycle
      // finishes this episode and does not start the second.
      setTimeout(() => gate.release(), 50);
      await drained;
    } finally {
      activeGate = null;
      gate.release();
    }

    expect(container.dreaming.currentRunningJobId()).toBeNull();
    const run = await storedRun(jobId);
    expect(run?.status).toBe('completed');
    expect(run?.episodesProcessed).toBe(1);
    expect(gate.entered).toBe(1);
  });

  test('drain with nothing running is a no-op, and refuses new cycles after', async () => {
    const container = await freshContainer();

    await container.dreaming.drain(5_000);

    const runs = await txRead(async (tx) => {
      const r = await tx.run('MATCH (d:DreamRun) RETURN count(d) AS n');
      return Number(r.records[0]?.get('n'));
    });
    expect(runs).toBe(0);
    expect(() => container.dreaming.trigger()).toThrow(DreamShuttingDownError);
    await expect(container.dreaming.runCycle()).rejects.toBeInstanceOf(DreamShuttingDownError);
  });

  test('POST /dream after drain answers 503', async () => {
    const container = await freshContainer();
    const drainedApp = await buildHttpServer(container);
    await drainedApp.ready();
    try {
      await container.dreaming.drain(0);
      const res = await drainedApp.inject({ method: 'POST', url: '/dream', headers: auth });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false });
    } finally {
      await drainedApp.close();
    }
  });
});
