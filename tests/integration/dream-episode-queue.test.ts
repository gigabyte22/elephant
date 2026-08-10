// The dream work queue: per-episode markers instead of a global cursor.
//
// The cursor stored the CLIENT-supplied e.timestamp of the last processed
// episode and the selector was strictly greater-than, which produced two silent
// data-loss modes:
//
//   1. Any episode POSTed with a timestamp older than the cursor — i.e. the
//      backfill/import case the `ingest` origin exists to serve — was never
//      selected again, forever, and backlogEstimate reported zero.
//   2. The cursor advanced past FAILED episodes, so a transient embedder or
//      LLM outage destroyed that window with only a counter to show for it.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { EmbeddingAdapter } from '../../src/adapters/embeddings/types.ts';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
let embedderThrows = false;

beforeAll(async () => {
  const base = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  const embedder: EmbeddingAdapter = {
    ...base,
    async embedBatch(texts: string[]): Promise<number[][]> {
      if (embedderThrows) throw new Error('embedder unavailable (429)');
      return base.embedBatch(texts);
    },
  };
  const llm = createFakeLLMAdapter({
    extract: () => [
      {
        content: 'the user moved to berlin',
        category: 'attribute',
        confidence: 0.9,
        importance: 0.6,
        entityNames: ['user'],
      },
    ],
  });
  container = await bootstrap({ llm, embedder });
  app = await buildHttpServer(container);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await shutdown();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  embedderThrows = false;
  await write(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

async function postEpisode(text: string, timestamp?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/episodes',
    headers: json,
    payload: {
      agentId: 'a1',
      sessionId: 's1',
      rawTranscript: text,
      ...(timestamp ? { timestamp, origin: 'ingest' } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.episodeId as string;
}

async function marker(id: string) {
  return read(async (tx) => {
    const r = await tx.run(
      `MATCH (e:Episode {id: $id})
       RETURN e.dreamedAt AS dreamedAt, coalesce(e.dreamAttempts, 0) AS attempts,
              e.dreamNextAttemptAt AS nextAttemptAt`,
      { id },
    );
    const rec = r.records[0];
    return {
      dreamedAt: rec?.get('dreamedAt') ?? null,
      attempts: rec?.get('attempts') as number,
      nextAttemptAt: rec?.get('nextAttemptAt') ?? null,
    };
  });
}

// Clear the backoff so a retry is due now, without waiting a real minute.
async function makeRetryDue(id: string): Promise<void> {
  await write(async (tx) => {
    await tx.run('MATCH (e:Episode {id: $id}) SET e.dreamNextAttemptAt = NULL', { id });
  });
}

describe('backdated episodes are still dreamed', () => {
  test('an episode imported with an old timestamp is processed after a newer one', async () => {
    const recent = await postEpisode('the user moved to berlin');
    await container.dreaming.runCycle();
    expect((await marker(recent)).dreamedAt).not.toBeNull();

    // The import case: a transcript from months ago, POSTed now. Under the
    // cursor this was invisible forever — strictly-greater-than against a
    // cursor already advanced past it.
    const backdated = await postEpisode('the user used to live in munich', '2020-01-01T00:00:00Z');

    expect(await container.dreaming.backlogEstimate()).toBe(1);

    const run = await container.dreaming.runCycle();
    expect(run.episodesProcessed).toBe(1);
    expect((await marker(backdated)).dreamedAt).not.toBeNull();
    expect(await container.dreaming.backlogEstimate()).toBe(0);
  });
});

describe('failed episodes are retried, then dead-lettered', () => {
  test('a failure schedules a retry rather than skipping the episode', async () => {
    const id = await postEpisode('the user moved to berlin');
    embedderThrows = true;

    const run = await container.dreaming.runCycle();
    expect(run.episodesFailed).toBe(1);

    const m = await marker(id);
    expect(m.dreamedAt).toBeNull();
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt).not.toBeNull();

    // Still outstanding, and honestly reported as such.
    expect(await container.dreaming.backlogEstimate()).toBe(1);
  });

  test('backoff keeps the cycle from spinning on a poisoned episode', async () => {
    const id = await postEpisode('the user moved to berlin');
    embedderThrows = true;
    await container.dreaming.runCycle();

    // Not due yet, so the next cycle finds nothing to do.
    const followup = await container.dreaming.runCycle();
    expect(followup.episodesProcessed).toBe(0);
    expect((await marker(id)).attempts).toBe(1);
  });

  test('the episode succeeds on a later attempt once the outage clears', async () => {
    const id = await postEpisode('the user moved to berlin');
    embedderThrows = true;
    await container.dreaming.runCycle();

    embedderThrows = false;
    await makeRetryDue(id);

    const run = await container.dreaming.runCycle();
    expect(run.episodesProcessed).toBe(1);
    expect(run.factsCreated).toBeGreaterThan(0);
    expect((await marker(id)).dreamedAt).not.toBeNull();
    expect(await container.dreaming.backlogEstimate()).toBe(0);
  });

  test('after exhausting attempts it is dead-lettered and counted', async () => {
    const id = await postEpisode('the user moved to berlin');
    embedderThrows = true;

    // DREAM_MAX_ATTEMPTS defaults to 3.
    for (let i = 0; i < 3; i++) {
      await makeRetryDue(id);
      await container.dreaming.runCycle();
    }

    const m = await marker(id);
    expect(m.attempts).toBe(3);
    expect(m.dreamedAt).toBeNull();

    // No longer retried…
    expect(await container.dreaming.backlogEstimate()).toBe(0);
    // …but visible rather than silently lost, which is the whole point.
    expect(await container.dreaming.deadLetteredEstimate()).toBe(1);
  });

  test('/health surfaces both the backlog and the dead-letter count', async () => {
    const id = await postEpisode('the user moved to berlin');
    embedderThrows = true;
    for (let i = 0; i < 3; i++) {
      await makeRetryDue(id);
      await container.dreaming.runCycle();
    }

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.dream).toMatchObject({
      backlogEstimate: 0,
      deadLetteredEpisodes: 1,
    });
  });
});

describe('ordering', () => {
  test('the queue drains in transaction-time order, not client-timestamp order', async () => {
    // Written second but backdated, so event-time ordering would put it first.
    const first = await postEpisode('written first');
    const second = await postEpisode('written second', '2020-01-01T00:00:00Z');

    const pending = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (e:Episode) WHERE e.dreamedAt IS NULL
         RETURN e.id AS id ORDER BY coalesce(e.recordedAt, e.timestamp) ASC`,
      );
      return r.records.map((rec) => rec.get('id') as string);
    });
    expect(pending).toEqual([first, second]);
  });
});
