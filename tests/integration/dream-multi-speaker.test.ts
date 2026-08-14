// Multi-party episodes: declared participants + per-fact attribution.
//
// A shared-thread transcript carries several humans. Without attribution every
// extracted fact inherited the episode's single userId — whoever's session
// posted the episode owned everyone's facts. With `participants` declared, the
// extractor names who each fact is about and the dreamer scopes it to that
// person's userId (or to the shared bucket for objective claims).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import type { ExtractedFact } from '../../src/models/types.ts';
import { EpisodeRepository } from '../../src/repositories/EpisodeRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };

const PARTICIPANTS = [{ label: 'alice', userId: 'u:alice' }, { label: 'bob' }];

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
let extractResult: ExtractedFact[] = [];

beforeAll(async () => {
  const llm = createFakeLLMAdapter({ extract: () => extractResult });
  container = await bootstrap({ llm, embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }) });
  app = await buildHttpServer(container);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await shutdown();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  await write(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
  extractResult = [];
});

async function ingest(payload: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/episodes',
    headers: json,
    payload: {
      agentId: 'a1',
      sessionId: 's1',
      userId: 'u:greg',
      rawTranscript: 'USER(alice): I prefer dark mode\n\nUSER(bob): the API limit is 100/s',
      ...payload,
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.episodeId as string;
}

function fact(content: string, subject?: string | null): ExtractedFact {
  return {
    content,
    confidence: 0.8,
    importance: 0.5,
    entityNames: [],
    ...(subject === undefined ? {} : { subject }),
  };
}

async function factUserIds(): Promise<Map<string, string | null>> {
  return read(async (tx) => {
    const r = await tx.run('MATCH (f:Fact) RETURN f.content AS content, f.userId AS userId');
    return new Map(
      r.records.map((rec) => [rec.get('content') as string, rec.get('userId') as string | null]),
    );
  });
}

describe('participants on POST /episodes', () => {
  test('round-trip through the repository', async () => {
    const id = await ingest({ participants: PARTICIPANTS });
    const ep = await read((tx) => EpisodeRepository.get(tx, id));
    expect(ep?.participants).toEqual(PARTICIPANTS);
  });

  test('an empty array normalizes to absent', async () => {
    const id = await ingest({ participants: [] });
    const ep = await read((tx) => EpisodeRepository.get(tx, id));
    expect(ep?.participants).toBeUndefined();
  });

  test('duplicate labels are rejected case-insensitively', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/episodes',
      headers: json,
      payload: {
        agentId: 'a1',
        sessionId: 's1',
        rawTranscript: 'USER(alice): hi',
        participants: [{ label: 'alice' }, { label: 'Alice' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('dream extraction attributes facts to participants', () => {
  test('each subject state scopes to the right bucket', async () => {
    extractResult = [
      fact('alice prefers dark mode', 'alice'), // declared, has userId
      fact('bob dislikes standups', 'bob'), // declared, no userId → shared
      fact('the api rate limit is 100/s', null), // objective → shared
      fact('charlie joined the team', 'charlie'), // unknown label → episode userId
      fact('the deploy runs on fridays'), // no subject → episode userId
    ];
    await ingest({ participants: PARTICIPANTS });

    await container.dreaming.runCycle();

    const got = await factUserIds();
    expect(got.get('alice prefers dark mode')).toBe('u:alice');
    expect(got.get('bob dislikes standups')).toBeNull();
    expect(got.get('the api rate limit is 100/s')).toBeNull();
    expect(got.get('charlie joined the team')).toBe('u:greg');
    expect(got.get('the deploy runs on fridays')).toBe('u:greg');
  });

  test('without participants, subject is ignored and the episode userId inherited', async () => {
    // A model that emits `subject` unprompted must not change single-user
    // behavior — that is the backward-compatibility pin.
    extractResult = [fact('alice prefers dark mode', 'alice'), fact('a shared claim', null)];
    await ingest({});

    await container.dreaming.runCycle();

    const got = await factUserIds();
    expect(got.get('alice prefers dark mode')).toBe('u:greg');
    expect(got.get('a shared claim')).toBe('u:greg');
  });
});
