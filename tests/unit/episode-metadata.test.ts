// `metadata` on POST /episodes is provenance and nothing else: the wire accepts
// a small string map, the repository stores it as an opaque JSON string beside
// `participants`, and no other layer reads it. The bounds are the load-bearing
// part — an unbounded map would make the field a second payload, smuggled past
// chunking, embedding and every size check that guards the transcript.

import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { ManagedTransaction } from 'neo4j-driver';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { errorHandler } from '../../src/http/errors.ts';
import { registerEpisodesRoute } from '../../src/http/routes/episodes.ts';
import { registerHealthRoute } from '../../src/http/routes/health.ts';
import type { App } from '../../src/http/types.ts';
import type { Container } from '../../src/index.ts';
import type { Episode } from '../../src/models/types.ts';
import { EpisodeRepository } from '../../src/repositories/EpisodeRepository.ts';

// /health touches Neo4j; the route swallows the failure and still reports the
// static capability flags, which is exactly what this asserts.
vi.mock('../../src/config/neo4j.ts', () => ({
  verifyConnectivity: vi.fn(async () => {
    throw new Error('no database in a unit test');
  }),
  read: vi.fn(async () => {
    throw new Error('no database in a unit test');
  }),
}));

const ingestEpisode = vi.fn(async (input: { id?: string }) => ({
  ...input,
  id: input.id ?? '00000000-0000-4000-8000-000000000001',
}));

function buildApp(): App {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  const container = {
    ingestion: { ingestEpisode },
    llm: { name: 'fake-llm', maxContextTokens: 8192 },
    embedder: { name: 'fake-embedder', dim: 8, maxInputTokens: 512 },
    dreaming: {
      backlogEstimate: async () => 0,
      deadLetteredEstimate: async () => 0,
      lastCompleted: async () => null,
      currentRunningJobId: () => null,
      currentLastDurationMs: () => null,
    },
    knowledge: { extractionQueueDepth: async () => ({ pending: 0, deadLettered: 0 }) },
  } as unknown as Container;

  registerHealthRoute(app, container);
  registerEpisodesRoute(app, container);
  return app;
}

const baseBody = {
  agentId: 'cerebro',
  sessionId: 'session-1',
  rawTranscript: 'USER: hello\nASSISTANT: hi',
};

// One owner for the app lifecycle: every case gets a fresh app and closes it.
async function inject(options: {
  method: 'GET' | 'POST';
  url: string;
  payload?: Record<string, unknown>;
}) {
  const app = buildApp();
  try {
    return await app.inject(options);
  } finally {
    await app.close();
  }
}

function post(body: Record<string, unknown>) {
  return inject({ method: 'POST', url: '/episodes', payload: body });
}

beforeEach(() => {
  ingestEpisode.mockClear();
});

describe('POST /episodes metadata', () => {
  test('accepts a provenance map and hands it to ingestion unchanged', async () => {
    const metadata = {
      channelId: '!room:synapse.local',
      cerebroSessionId: '0199-abc',
      roomId: 'room-7',
      turnId: 'turn-42',
    };
    const res = await post({ ...baseBody, metadata });

    expect(res.statusCode).toBe(200);
    expect(ingestEpisode).toHaveBeenCalledTimes(1);
    expect(ingestEpisode.mock.calls[0]![0]).toMatchObject({ metadata });
  });

  test('omitting it leaves the field undefined — old clients are unaffected', async () => {
    const res = await post(baseBody);

    expect(res.statusCode).toBe(200);
    expect(ingestEpisode.mock.calls[0]![0]).not.toHaveProperty('metadata');
  });

  test('rejects more than 16 entries', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']));
    const res = await post({ ...baseBody, metadata });

    expect(res.statusCode).toBe(400);
    expect(ingestEpisode).not.toHaveBeenCalled();
  });

  test('accepts exactly 16 entries — the bound is inclusive', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v']));
    const res = await post({ ...baseBody, metadata });

    expect(res.statusCode).toBe(200);
  });

  test('rejects a value over 512 characters', async () => {
    const res = await post({ ...baseBody, metadata: { roomId: 'x'.repeat(513) } });

    expect(res.statusCode).toBe(400);
    expect(ingestEpisode).not.toHaveBeenCalled();
  });

  test('rejects a non-string value — the map is strings only', async () => {
    const res = await post({ ...baseBody, metadata: { turnId: 42 } });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /health', () => {
  test('advertises episodeMetadata so a client can feature-detect', async () => {
    const res = await inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { episodeMetadata?: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.episodeMetadata).toBe(true);
  });
});

describe('EpisodeRepository metadata round-trip', () => {
  const episode = (metadata?: Record<string, string>): Episode => ({
    id: '00000000-0000-4000-8000-000000000002',
    agentId: 'cerebro',
    sessionId: 'session-1',
    timestamp: new Date('2026-09-18T12:00:00.000Z'),
    rawTranscript: 'USER: hello',
    summary: 'a greeting',
    embedding: [0.1, 0.2],
    metadata,
  });

  // A stand-in transaction: capture the params, echo back the node the write
  // would have produced, so one call covers both the SET and the mapper.
  function fakeTx(nodeOverrides: Record<string, unknown> = {}) {
    const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
    const tx = {
      run: async (cypher: string, params: Record<string, unknown>) => {
        calls.push({ cypher, params });
        return { records: [{ get: () => ({ ...params, ...nodeOverrides }) }] };
      },
    } as unknown as ManagedTransaction;
    return { tx, calls };
  }

  test('stores the map as a JSON string and parses it back', async () => {
    const metadata = { roomId: 'room-7', turnId: 'turn-42' };
    const { tx, calls } = fakeTx();

    const saved = await EpisodeRepository.create(tx, episode(metadata));

    expect(calls[0]!.cypher).toContain('e.metadata = $metadata');
    expect(calls[0]!.params.metadata).toBe(JSON.stringify(metadata));
    expect(saved.metadata).toEqual(metadata);
  });

  test('absent or empty metadata is written as null, not "{}"', async () => {
    for (const value of [undefined, {}]) {
      const { tx, calls } = fakeTx();
      const saved = await EpisodeRepository.create(tx, episode(value));

      expect(calls[0]!.params.metadata).toBeNull();
      expect(saved.metadata).toBeUndefined();
    }
  });

  test('a corrupt prop degrades to no provenance rather than failing the read', async () => {
    for (const corrupt of ['not json', '["a"]', '{"k":3}']) {
      const { tx } = fakeTx({ metadata: corrupt });
      const saved = await EpisodeRepository.create(tx, episode({ roomId: 'room-7' }));

      expect(saved.metadata).toBeUndefined();
    }
  });
});
