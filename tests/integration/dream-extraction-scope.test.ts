// The extraction prompt's "already-known related facts" sample must respect
// the same scope bucket as dedup and supersede.
//
// It was the one similar-fact search in the dreamer with no scope at all, and
// it is the one whose result leaves the process: the sampled fact CONTENT is
// injected into an outbound LLM call. So an isolated project's episode shipped
// other projects' and other users' facts to the model — the exact thing
// Episode.isolated exists to prevent.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import type { LLMAdapter } from '../../src/adapters/llm/types.ts';
import { write } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import type { Fact } from '../../src/models/types.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };

const SECRET = 'acme quarterly revenue was 4.2 million';
const OTHER_USER_SECRET = 'dana takes lithium every morning';

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
// Every existingFacts payload handed to the extraction LLM this cycle.
let sampled: Array<Pick<Fact, 'id' | 'content'>[]> = [];

beforeAll(async () => {
  const base = createFakeLLMAdapter({
    extract: () => [
      {
        content: 'the beta launch slipped a week',
        category: 'event',
        confidence: 0.8,
        importance: 0.5,
        entityNames: ['launch'],
      },
    ],
  });
  const llm: LLMAdapter = {
    ...base,
    async extractFacts(input) {
      sampled.push(input.existingFacts ?? []);
      return base.extractFacts(input);
    },
  };
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
  sampled = [];
});

async function saveFact(content: string, scope: Record<string, string>): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/facts',
    headers: json,
    payload: { content, ...scope },
  });
  expect(res.statusCode).toBe(200);
}

async function ingestEpisode(payload: Record<string, unknown>): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/episodes',
    headers: json,
    payload: {
      agentId: 'a1',
      sessionId: 's1',
      // The transcript is deliberately near-identical to the seeded facts so
      // they are genuinely the nearest neighbours — the scope predicate is
      // what must exclude them, not distance.
      rawTranscript: `${SECRET}. ${OTHER_USER_SECRET}. The beta launch slipped a week.`,
      ...payload,
    },
  });
  expect(res.statusCode).toBe(200);
}

function sampledContents(): string[] {
  return sampled.flat().map((f) => f.content);
}

describe('extraction prompt sample is scoped', () => {
  test("an isolated project's episode never samples another project's facts", async () => {
    await saveFact(SECRET, { projectId: 'acme' });
    await ingestEpisode({ projectId: 'zenith', isolated: true });

    await container.dreaming.runCycle();

    expect(sampled.length).toBeGreaterThan(0);
    expect(sampledContents()).not.toContain(SECRET);
  });

  test("an isolated project's episode never samples the unscoped personal bucket", async () => {
    await saveFact(OTHER_USER_SECRET, {});
    await ingestEpisode({ projectId: 'zenith', isolated: true });

    await container.dreaming.runCycle();

    expect(sampledContents()).not.toContain(OTHER_USER_SECRET);
  });

  test('a non-isolated project still samples its own facts', async () => {
    await saveFact(SECRET, { projectId: 'acme' });
    await ingestEpisode({ projectId: 'acme' });

    await container.dreaming.runCycle();

    expect(sampledContents()).toContain(SECRET);
  });

  // userId guards every dedupScope branch (see FactRepository.listSimilar): an
  // episode samples shared (null-user) facts and its own user's, never another
  // human's — same project, unscoped bucket and widened branch alike.
  test("a project owned by one user does not sample another user's personal facts", async () => {
    await saveFact(OTHER_USER_SECRET, { userId: 'dana' });
    await ingestEpisode({ projectId: 'acme', userId: 'ravi' });

    await container.dreaming.runCycle();

    expect(sampledContents()).not.toContain(OTHER_USER_SECRET);
  });

  test("an unscoped episode from one user does not sample another user's facts", async () => {
    await saveFact(OTHER_USER_SECRET, { userId: 'dana' });
    await ingestEpisode({ userId: 'ravi' });

    await container.dreaming.runCycle();

    expect(sampledContents()).not.toContain(OTHER_USER_SECRET);
  });

  test("one user's project episode does not sample a teammate's facts in the same project", async () => {
    await saveFact(SECRET, { projectId: 'acme', userId: 'dana' });
    await ingestEpisode({ projectId: 'acme', userId: 'ravi' });

    await container.dreaming.runCycle();

    expect(sampledContents()).not.toContain(SECRET);
  });

  test("a user's episode still samples shared null-user facts", async () => {
    await saveFact(SECRET, {});
    await ingestEpisode({ userId: 'ravi' });

    await container.dreaming.runCycle();

    expect(sampledContents()).toContain(SECRET);
  });

  test('a project does sample its own owner’s personal facts', async () => {
    await saveFact(OTHER_USER_SECRET, { userId: 'ravi' });
    await ingestEpisode({ projectId: 'acme', userId: 'ravi' });

    await container.dreaming.runCycle();

    expect(sampledContents()).toContain(OTHER_USER_SECRET);
  });
});
