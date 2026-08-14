// Preferences and observations were writable but not scopable.
//
// PreferenceRepository.set accepted a `scope` argument that no caller ever
// passed, and matched the prior version on `key` alone — so in any multi-project
// deployment a PUT from project A superseded project B's value and emitted a
// supersede audit event against it. Every preference was a global singleton.
//
// Observations had the same shape: the route accepted no scope, so every node
// was written with projectId/userId null while PostFilterStage still filtered
// on both axes — meaning projectScope=strict returned zero observations, always.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { PreferenceRepository } from '../../src/repositories/PreferenceRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'content-type': 'application/json' };

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

beforeAll(async () => {
  container = await bootstrap({
    llm: createFakeLLMAdapter({}),
    embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
  });
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
});

function setPref(key: string, value: string, scope: Record<string, string> = {}) {
  return app.inject({
    method: 'PUT',
    url: `/preferences/${key}`,
    headers: json,
    payload: { value, ...scope },
  });
}

function getPref(key: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return app.inject({
    method: 'GET',
    url: `/preferences/${key}${qs ? `?${qs}` : ''}`,
    headers: auth,
  });
}

describe('preferences are identified by (key, projectId, userId)', () => {
  test('two projects hold independent values for the same key', async () => {
    expect((await setPref('tone', 'formal', { projectId: 'acme' })).statusCode).toBe(200);
    expect((await setPref('tone', 'playful', { projectId: 'zenith' })).statusCode).toBe(200);

    expect((await getPref('tone', { projectId: 'acme' })).json().data.value).toBe('formal');
    expect((await getPref('tone', { projectId: 'zenith' })).json().data.value).toBe('playful');
  });

  test("writing one project's value does not supersede another's", async () => {
    await setPref('tone', 'formal', { projectId: 'acme' });
    await setPref('tone', 'playful', { projectId: 'zenith' });

    // The acme row must still be live, unversioned, and un-superseded.
    const acme = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (p:Preference {key: 'tone', projectId: 'acme'})
         OPTIONAL MATCH (:Preference)-[s:SUPERSEDES]->(p)
         RETURN p.validTo AS validTo, p.value AS value, count(s) AS supersededBy`,
      );
      const rec = r.records[0];
      return {
        validTo: rec?.get('validTo') ?? null,
        value: rec?.get('value') as string,
        supersededBy: (rec?.get('supersededBy') as number) ?? 0,
      };
    });
    expect(acme.validTo).toBeNull();
    expect(acme.value).toBe('formal');
    expect(acme.supersededBy).toBe(0);
  });

  test('the unscoped preference is its own row, not a wildcard', async () => {
    await setPref('tone', 'neutral');
    await setPref('tone', 'formal', { projectId: 'acme' });

    expect((await getPref('tone')).json().data.value).toBe('neutral');
    expect((await getPref('tone', { projectId: 'acme' })).json().data.value).toBe('formal');
  });

  test('a scoped preference is not visible unscoped', async () => {
    await setPref('tone', 'formal', { projectId: 'acme' });
    expect((await getPref('tone')).statusCode).toBe(404);
  });

  test('updating within one scope still supersedes that scope', async () => {
    await setPref('tone', 'formal', { projectId: 'acme' });
    await setPref('tone', 'blunt', { projectId: 'acme' });

    expect((await getPref('tone', { projectId: 'acme' })).json().data.value).toBe('blunt');
    const live = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (p:Preference {key: 'tone'}) WHERE p.validTo IS NULL RETURN count(p) AS n`,
      );
      return (r.records[0]?.get('n') as number) ?? 0;
    });
    expect(live).toBe(1);
  });

  test('GET /preferences lists only the requested scope', async () => {
    await setPref('tone', 'formal', { projectId: 'acme' });
    await setPref('tone', 'playful', { projectId: 'zenith' });
    await setPref('locale', 'en-GB', { projectId: 'acme' });

    const res = await app.inject({
      method: 'GET',
      url: '/preferences?projectId=acme',
      headers: auth,
    });
    const keys = (res.json().data.preferences as Array<{ key: string; value: string }>).map(
      (p) => `${p.key}=${p.value}`,
    );
    expect(keys.sort()).toEqual(['locale=en-GB', 'tone=formal']);
  });

  // set() is read-then-write and Neo4j has no partial unique constraint to
  // express "one live row per identity", so this used to leave the key
  // permanently double-valued.
  test('concurrent writes to one key leave exactly one live version', async () => {
    await Promise.all([
      setPref('tone', 'a', { projectId: 'acme' }),
      setPref('tone', 'b', { projectId: 'acme' }),
      setPref('tone', 'c', { projectId: 'acme' }),
    ]);

    const live = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (p:Preference {key: 'tone'}) WHERE p.validTo IS NULL RETURN count(p) AS n`,
      );
      return (r.records[0]?.get('n') as number) ?? 0;
    });
    expect(live).toBe(1);
  });
});

describe('preference recall pushes scope into the vector query', () => {
  // The vector index returns the GLOBAL top-K, so a fixed K plus a caller-side
  // filter lets other users' semantically-similar rows crowd this user's out
  // and recall silently returns nothing for them.
  test("listSimilar with a filter scope never returns other users' rows", async () => {
    for (let i = 0; i < 6; i++) {
      await setPref(`style.${i}`, 'concise answers', { userId: 'dana' });
    }
    await setPref('style.mine', 'concise answers', { userId: 'ravi' });
    await setPref('style.shared', 'concise answers');

    const vec = await container.embedder.embed('style: concise answers');

    // limit ≥ every seeded row, so the global top-K contains them all and the
    // only thing separating users is the pushed-down predicate.
    const filtered = await read((tx) =>
      PreferenceRepository.listSimilar(tx, {
        embedding: vec,
        limit: 50,
        scope: { userId: 'ravi', userScope: 'filter' },
      }),
    );
    expect(filtered.map((p) => p.key).sort()).toEqual(['style.mine', 'style.shared']);

    const strict = await read((tx) =>
      PreferenceRepository.listSimilar(tx, {
        embedding: vec,
        limit: 50,
        scope: { userId: 'ravi', userScope: 'strict' },
      }),
    );
    expect(strict.map((p) => p.key)).toEqual(['style.mine']);

    const unscoped = await read((tx) =>
      PreferenceRepository.listSimilar(tx, { embedding: vec, limit: 50 }),
    );
    expect(unscoped).toHaveLength(8);
  });

  test("a user's preference survives recall despite other users' crowd", async () => {
    for (let i = 0; i < 30; i++) {
      await setPref(`noise.${i}`, 'prefers concise answers', { userId: 'dana' });
    }
    await setPref('style', 'prefers concise answers', { userId: 'ravi' });

    const params = new URLSearchParams({
      q: 'prefers concise answers',
      includePreferences: 'true',
      userId: 'ravi',
      userScope: 'filter',
      limit: '3',
    });
    const res = await app.inject({ method: 'GET', url: `/recall?${params}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const prefs = (res.json().data.preferences ?? []) as Array<{ key: string }>;
    expect(prefs.map((p) => p.key)).toContain('style');
  });
});

describe('observations carry scope', () => {
  test('projectId and userId are persisted and survive strict-scope recall', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/observations',
      headers: json,
      payload: {
        agentId: 'a1',
        sessionId: 's1',
        content: 'the build is red on main',
        projectId: 'acme',
        userId: 'ravi',
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data).toMatchObject({ projectId: 'acme', userId: 'ravi' });

    const params = new URLSearchParams({
      q: 'the build is red on main',
      sessionId: 's1',
      includeObservations: 'true',
      projectId: 'acme',
      projectScope: 'strict',
      limit: '10',
    });
    const res = await app.inject({ method: 'GET', url: `/recall?${params}`, headers: auth });
    expect(res.statusCode).toBe(200);
    // Under strict scope a null-scoped observation is excluded, so before the
    // write path carried scope this list was necessarily empty.
    expect((res.json().data.observations ?? []).length).toBeGreaterThan(0);
  });

  test('an unscoped observation is still excluded under strict scope', async () => {
    await app.inject({
      method: 'POST',
      url: '/observations',
      headers: json,
      payload: { agentId: 'a1', sessionId: 's1', content: 'the build is red on main' },
    });

    const params = new URLSearchParams({
      q: 'the build is red on main',
      sessionId: 's1',
      includeObservations: 'true',
      projectId: 'acme',
      projectScope: 'strict',
      limit: '10',
    });
    const res = await app.inject({ method: 'GET', url: `/recall?${params}`, headers: auth });
    expect(res.json().data.observations ?? []).toHaveLength(0);
  });
});
