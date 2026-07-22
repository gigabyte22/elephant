// End-to-end verification of `packages/client` against a REAL listening server.
//
// Every other client/adapter test in this repo uses a fake transport, which
// asserts shape but never behaviour. That gap is not theoretical: hermes shipped
// a `save_fact` that sent `category: null`, and since zod `.optional()` accepts a
// missing key but rejects an explicit null, it would have 400'd on every write
// against a real server while the fake-transport suite stayed green.
//
// `app.inject()` would exercise routing + validation, but the client calls
// `fetch`, so this binds a real ephemeral port and drives the actual client over
// a socket — the only way to catch querystring encoding, envelope unwrapping and
// null-vs-absent bugs at once.

import { randomUUID } from 'node:crypto';
import { ElephantClient } from '@elephant/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
let client: ElephantClient;

const PROJECT = `proj-${randomUUID()}`;
const AGENT = 'client-live-test';
const SESSION = `sess-${randomUUID()}`;

beforeAll(async () => {
  assertDestructiveAllowed();
  container = await bootstrap({
    llm: createFakeLLMAdapter({}),
    embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
  });
  app = await buildHttpServer(container);
  // Port 0 => OS picks a free port. Real socket, real fetch, real HTTP.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('expected a TCP address');
  client = new ElephantClient({ url: `http://127.0.0.1:${addr.port}`, token: TOKEN, retries: 0 });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await shutdown();
});

describe('health + envelope', () => {
  test('health unwraps the {ok,data} envelope', async () => {
    const health = await client.health();
    expect(health.neo4j).toBe(true);
    expect(health.embedder.dim).toBe(EMBED_DIM);
  });
});

describe('facts', () => {
  test('saveFact omits unset optionals rather than sending null', async () => {
    // The exact shape that 400s if a client sends `category: null` explicitly.
    const fact = await client.saveFact({ content: 'live-test fact one', agentId: AGENT });
    expect(fact.id).toBeTruthy();
    expect(fact.validTo).toBeNull();
  });

  test('full field set round-trips', async () => {
    const fact = await client.saveFact({
      content: 'live-test fact two',
      category: 'testing',
      confidence: 0.9,
      importance: 0.8,
      entityNames: ['Elephant'],
      projectId: PROJECT,
      agentId: AGENT,
      sessionId: SESSION,
      actor: 'client-live-spec',
    });
    expect(fact.category).toBe('testing');
    expect(fact.importance).toBeCloseTo(0.8);
    const fetched = await client.getEntity((await client.searchEntities('Elephant')).entities[0]!.id);
    expect(fetched.entity.name).toBeTruthy();
  });

  test('batch + supersede + soft delete', async () => {
    const saved = await client.saveFacts([
      { content: 'batch fact A', agentId: AGENT },
      { content: 'batch fact B', agentId: AGENT },
    ]);
    expect(saved).toHaveLength(2);
    const res = await client.supersedeFact(saved[0]!.id, saved[1]!.id, 'superseded by B');
    expect(res.ok).toBe(true);
    expect((await client.deleteFact(saved[1]!.id)).deleted).toBe(true);
  });
});

describe('recall — the v1.2 opt-ins actually reach the server', () => {
  test('every include flag and both new kinds are accepted', async () => {
    const result = await client.recall({
      q: 'live-test',
      agentId: AGENT,
      projectId: PROJECT,
      projectScope: 'boost',
      kinds: ['fact', 'research_chunk', 'intention'],
      includeChunks: true,
      includePreferences: true,
      includeInsights: true,
      includeKnowledge: true,
      includeProcedures: true,
      includeResearch: true,
      includeIntentions: true,
      ppr: true,
      debug: true,
      limit: 20,
      chunkNeighborRadius: 1,
    });
    expect(Array.isArray(result.facts)).toBe(true);
    // debug:true must produce a trace — proves queryBool parsed our 'true'.
    expect(result.trace).toBeDefined();
    expect(result.trace?.stageTimingsMs).toBeDefined();
  });

  test('queryBool rejects nothing but only accepts truthy spellings', async () => {
    const off = await client.recall({ q: 'live-test', debug: false });
    expect(off.trace).toBeUndefined();
  });
});

describe('research — including the previously unwrapped PUT', () => {
  let researchId: string;

  test('create returns the full content body', async () => {
    const doc = await client.createResearch({
      title: 'Live research',
      source: 'client-live-spec',
      content: 'original research body',
      projectId: PROJECT,
    });
    researchId = doc.id;
    expect(doc.content).toBe('original research body');
    expect(doc.projectId).toBe(PROJECT);
  });

  test('updateResearch round-trips and archives a revision', async () => {
    const updated = await client.updateResearch(researchId, {
      content: 'revised research body',
      reason: 'live-test revision',
      actor: 'client-live-spec',
    });
    expect(updated.content).toBe('revised research body');

    // The bug this spec exists for: revisions carry `snapshot`, not `payload`.
    const audit = await client.audit(researchId);
    expect(audit.revisions.length).toBeGreaterThan(0);
    const rev = audit.revisions[0]!;
    expect(rev).toHaveProperty('snapshot');
    expect(rev.originalId).toBe(researchId);
    expect(rev.archivedAt).toBeTruthy();
    expect(typeof rev.reason).toBe('string');
  });

  test('getResearch forwards projectId; cross-project 404s', async () => {
    const scoped = await client.getResearch(researchId, { projectId: PROJECT });
    expect(scoped.id).toBe(researchId);
    await expect(client.getResearch(researchId, { projectId: 'some-other-project' })).rejects.toMatchObject({ status: 404 });
  });

  test('list requires projectId and returns bodies', async () => {
    const rows = await client.listResearch({ projectId: PROJECT, limit: 10 });
    expect(rows.some((r) => r.id === researchId)).toBe(true);
  });
});

describe('knowledge', () => {
  test('ingest, update with reason, attachment, purge', async () => {
    const doc = await client.ingestKnowledge({
      title: 'Live knowledge',
      source: 'client-live-spec',
      content: 'knowledge body',
      tags: ['live'],
      scope: { projectId: PROJECT },
    });
    // `reason` was missing from the client's update input entirely.
    const updated = await client.updateKnowledge(doc.id, {
      summary: 'updated summary',
      reason: 'live-test',
      actor: 'client-live-spec',
    });
    expect(updated.summary).toBe('updated summary');

    const att = await client.uploadAttachment(doc.id, {
      filename: 'note.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from('hello').toString('base64'),
    });
    expect(att.filename).toBe('note.txt');

    // The one route that does NOT use the {ok,data} envelope.
    const blob = await client.fetchAttachmentBlob(att.blobId);
    expect(await blob.text()).toBe('hello');

    const del = await client.deleteKnowledge(doc.id, true);
    expect(del.deleted).toBe(true);
    expect(typeof del.chunksDeleted).toBe('number');
  });
});

describe('procedures, intentions, state, audit', () => {
  test('procedure create/get-by-name/update/delete', async () => {
    const name = `proc-${randomUUID()}`;
    const proc = await client.createProcedure({
      name,
      content: 'do the thing',
      whenToUse: 'when the thing needs doing',
      scope: { projectId: PROJECT },
    });
    const byName = await client.getProcedureByName(name, { projectId: PROJECT });
    expect(byName[0]?.id).toBe(proc.id);
    const bumped = await client.updateProcedure(proc.id, { successRate: 0.5, reason: 'live-test' });
    expect(bumped.successRate).toBeCloseTo(0.5);
    expect((await client.deleteProcedure(proc.id)).deleted).toBe(true);
  });

  test('intention lifecycle', async () => {
    const created = await client.createIntention({
      content: 'follow up on the live test',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      importance: 0.6,
      scope: { projectId: PROJECT, agentId: AGENT },
    });
    expect(created.status).toBe('pending');
    expect((await client.listIntentions({ projectId: PROJECT, status: 'pending' })).length).toBeGreaterThan(0);
    const due = await client.listDueIntentions({
      projectId: PROJECT,
      before: new Date(Date.now() + 172_800_000).toISOString(),
    });
    expect(due.some((i) => i.id === created.id)).toBe(true);
    await client.markIntentionFired(created.id);
    const done = await client.completeIntention(created.id, { actor: 'client-live-spec' });
    expect(done.status).toBe('completed');
  });

  test('working state set/get/list/delete', async () => {
    const scope = { agentId: AGENT, projectId: PROJECT };
    const key = `k-${randomUUID()}`;
    expect((await client.setState({ scope, key, value: { n: 1 }, ttlSec: 60 })).ok).toBe(true);
    const entry = await client.getState(key, scope);
    expect(entry.value).toEqual({ n: 1 });
    expect((await client.listState({ ...scope })).some((e) => e.key === key)).toBe(true);
    expect((await client.deleteState(key, scope)).deleted).toBe(true);
  });

  test('preferences and observations', async () => {
    const key = `pref-${randomUUID()}`;
    const pref = await client.putPreference(key, 'value-one', { confidence: 0.8, actor: 'spec' });
    expect(pref.value).toBe('value-one');
    expect((await client.getPreference(key)).value).toBe('value-one');
    await client.writeObservation({ agentId: AGENT, sessionId: SESSION, content: 'an observation' });
    // Note the envelope: this route returns `{observations: [...]}`, not a bare array.
    expect((await client.listObservations(SESSION)).observations.length).toBeGreaterThan(0);
  });

  test('audit list and timeline accept date params', async () => {
    const events = await client.auditList({ from: new Date(Date.now() - 3_600_000), limit: 10 });
    expect(Array.isArray(events)).toBe(true);
    const tl = await client.timeline(new Date());
    expect(Array.isArray(tl.facts)).toBe(true);
  });
});

describe('episodes', () => {
  test('origin and isolated are accepted', async () => {
    const res = await client.ingestEpisode({
      agentId: AGENT,
      sessionId: SESSION,
      rawTranscript: 'USER: hello\nASSISTANT: hi',
      origin: 'ingest',
      isolated: false,
      projectId: PROJECT,
    });
    expect(res.episodeId).toBeTruthy();
  });
});
