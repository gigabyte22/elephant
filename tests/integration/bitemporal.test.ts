// Bi-temporal correctness: event/valid time vs transaction time on create,
// supersede, merge collapse on timeline, and episode-linked fact/intention writes.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import type { ExtractedFact, Fact } from '../../src/models/types.ts';
import { FactRepository } from '../../src/repositories/FactRepository.ts';
import { newId } from '../../src/utils/ids.ts';
import { eventValidTo } from '../../src/utils/temporal.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };

const knobs = {
  extractMap: new Map<string, ExtractedFact[]>(),
};

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

beforeAll(async () => {
  const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  const llm = createFakeLLMAdapter({
    extract: ({ episode }): ExtractedFact[] => {
      const key = episode.rawTranscript.trim();
      return (
        knobs.extractMap.get(key) ?? [
          {
            content: `fact-from:${key}`,
            category: 'attribute',
            confidence: 0.8,
            importance: 0.5,
            entityNames: ['Thing'],
          },
        ]
      );
    },
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
  await write(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
  knobs.extractMap.clear();
});

function vec(seed: number): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  v[0] = seed;
  v[1] = 1 - seed;
  return v;
}

async function postEpisode(input: {
  rawTranscript: string;
  timestamp: string;
  sessionId?: string;
}): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/episodes',
    headers: auth,
    payload: {
      agentId: 'agent-1',
      sessionId: input.sessionId ?? 'sess-1',
      rawTranscript: input.rawTranscript,
      timestamp: input.timestamp,
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.episodeId as string;
}

describe('bi-temporal correctness', () => {
  test('dream fact: validFrom = episode timestamp, recordedAt ≈ now', async () => {
    const epTs = '2024-03-15T10:00:00.000Z';
    const before = Date.now();
    knobs.extractMap.set('alice lives in berlin', [
      {
        content: 'Alice lives in Berlin',
        category: 'attribute',
        confidence: 0.9,
        importance: 0.6,
        entityNames: ['Alice', 'Berlin'],
      },
    ]);
    await postEpisode({ rawTranscript: 'alice lives in berlin', timestamp: epTs });
    const run = await container.dreaming.runCycle();
    expect(run.status).toBe('completed');
    expect(run.factsCreated).toBeGreaterThanOrEqual(1);

    const facts = await read(async (tx) => {
      const r = await tx.run('MATCH (f:Fact) RETURN f {.*} AS f');
      return r.records.map((rec) => rec.get('f') as Record<string, unknown>);
    });
    expect(facts.length).toBe(1);
    const f = facts[0]!;
    // Neo4j temporal → string via toString in driver mapping varies; use Date.
    const validFrom = new Date(
      typeof f.validFrom === 'object' && f.validFrom && 'toString' in f.validFrom
        ? (f.validFrom as { toString(): string }).toString()
        : (f.validFrom as string),
    );
    const recordedAt = new Date(
      typeof f.recordedAt === 'object' && f.recordedAt && 'toString' in f.recordedAt
        ? (f.recordedAt as { toString(): string }).toString()
        : (f.recordedAt as string),
    );
    expect(validFrom.toISOString()).toBe(epTs);
    expect(recordedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(recordedAt.getTime()).toBeGreaterThan(validFrom.getTime() + 86_400_000);
  });

  test('supersede splits validTo (event) from supersededAt (txn)', async () => {
    const t1 = new Date('2024-01-01T00:00:00.000Z');
    const t2 = new Date('2024-06-01T00:00:00.000Z');
    const oldId = newId();
    const newId_ = newId();
    const seedAt = new Date();

    await write(async (tx) => {
      await FactRepository.create(tx, {
        id: oldId,
        content: 'favorite color is blue',
        confidence: 0.8,
        importance: 0.5,
        validFrom: t1,
        validTo: null,
        recordedAt: seedAt,
        embedding: vec(0.1),
        entityIds: [],
      });
      await FactRepository.create(tx, {
        id: newId_,
        content: 'favorite color is green',
        confidence: 0.85,
        importance: 0.5,
        validFrom: t2,
        validTo: null,
        recordedAt: seedAt,
        embedding: vec(0.2),
        entityIds: [],
      });
    });

    const before = Date.now();
    await container.ingestion.supersede({
      oldId,
      newId: newId_,
      reason: 'contradiction',
    });
    const after = Date.now();

    const row = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (newF:Fact {id: $newId})-[rel:SUPERSEDES]->(oldF:Fact {id: $oldId})
         RETURN oldF.validTo AS oldTo, rel.supersededAt AS edgeAt`,
        { oldId, newId: newId_ },
      );
      return r.records[0]!;
    });
    expect(new Date(row.get('oldTo').toString()).toISOString()).toBe(
      eventValidTo(t1, t2).toISOString(),
    );
    const edgeAt = new Date(row.get('edgeAt').toString()).getTime();
    expect(edgeAt).toBeGreaterThanOrEqual(before - 50);
    expect(edgeAt).toBeLessThanOrEqual(after + 2000);
    expect(edgeAt).toBeGreaterThan(t2.getTime());
  });

  test('timeline after contradiction only returns later claim past event end', async () => {
    const t1 = new Date('2024-01-01T00:00:00.000Z');
    const t2 = new Date('2024-06-01T00:00:00.000Z');
    const oldId = newId();
    const newId_ = newId();
    const seedAt = new Date();

    await write(async (tx) => {
      await FactRepository.create(tx, {
        id: oldId,
        content: 'favorite color is blue',
        confidence: 0.8,
        importance: 0.5,
        validFrom: t1,
        validTo: null,
        recordedAt: seedAt,
        embedding: vec(0.1),
        entityIds: [],
      });
      await FactRepository.create(tx, {
        id: newId_,
        content: 'favorite color is green',
        confidence: 0.85,
        importance: 0.5,
        validFrom: t2,
        validTo: null,
        recordedAt: seedAt,
        embedding: vec(0.2),
        entityIds: [],
      });
    });
    await container.ingestion.supersede({
      oldId,
      newId: newId_,
      reason: 'contradiction',
    });

    const mid = await container.temporal.snapshotAt({
      at: new Date('2024-03-01T00:00:00.000Z'),
    });
    expect(mid.facts.some((f) => f.content.includes('blue'))).toBe(true);
    expect(mid.facts.some((f) => f.content.includes('green'))).toBe(false);

    const late = await container.temporal.snapshotAt({
      at: new Date('2024-07-01T00:00:00.000Z'),
    });
    expect(late.facts.some((f) => f.content.includes('green'))).toBe(true);
    expect(late.facts.some((f) => f.content.includes('blue'))).toBe(false);
  });

  test('POST /facts with sourceEpisodeId inherits episode timestamp', async () => {
    const epTs = '2023-08-01T12:00:00.000Z';
    const episodeId = await postEpisode({
      rawTranscript: 'context only',
      timestamp: epTs,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/facts',
      headers: auth,
      payload: {
        content: 'linked fact without explicit validFrom',
        sourceEpisodeId: episodeId,
        importance: 0.5,
        confidence: 0.9,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.validFrom).toBe(epTs);
    expect(new Date(body.recordedAt as string).getTime()).toBeGreaterThan(new Date(epTs).getTime());
  });

  test('snapshotAt collapses consolidation merge members', async () => {
    const now = new Date();
    const vf = new Date('2024-02-01T00:00:00.000Z');
    const a: Fact = {
      id: newId(),
      content: 'Alice works at Acme eng',
      confidence: 0.8,
      importance: 0.5,
      validFrom: vf,
      validTo: null,
      recordedAt: now,
      embedding: vec(0.3),
      entityIds: [],
    };
    const b: Fact = {
      id: newId(),
      content: 'Alice is a software engineer at Acme',
      confidence: 0.8,
      importance: 0.5,
      validFrom: vf,
      validTo: null,
      recordedAt: now,
      embedding: vec(0.4),
      entityIds: [],
    };
    const merged: Fact = {
      id: newId(),
      content: 'Alice is a software engineer at Acme (merged)',
      confidence: 0.85,
      importance: 0.55,
      validFrom: vf,
      validTo: null,
      recordedAt: now,
      embedding: vec(0.5),
      entityIds: [],
      mergedFromFactIds: [a.id, b.id],
    };

    await write(async (tx) => {
      await FactRepository.create(tx, a);
      await FactRepository.create(tx, b);
      await FactRepository.mergeFrom(tx, {
        newFact: merged,
        memberIds: [a.id, b.id],
        reason: 'consolidation',
        memberValidTo: now,
        supersededAt: now,
      });
    });

    const snap = await read((tx) =>
      FactRepository.snapshotAt(tx, { at: new Date('2024-03-01T00:00:00.000Z') }),
    );
    const ids = snap.map((f) => f.id);
    expect(ids).toContain(merged.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  // GET /recall?asOf is the ranked counterpart to GET /timeline. These assert
  // the two agree on which claim held, since recall reaches it through the
  // vector index and timeline through a plain interval scan.
  test('recall asOf returns the claim that held then, not the current one', async () => {
    const t1 = new Date('2024-01-01T00:00:00.000Z');
    const t2 = new Date('2024-06-01T00:00:00.000Z');
    const oldId = newId();
    const newId_ = newId();
    const seedAt = new Date();

    await write(async (tx) => {
      await FactRepository.create(tx, {
        id: oldId,
        content: 'favorite color is blue',
        confidence: 0.8,
        importance: 0.5,
        validFrom: t1,
        validTo: null,
        recordedAt: seedAt,
        embedding: vec(0.1),
        entityIds: [],
      });
      await FactRepository.create(tx, {
        id: newId_,
        content: 'favorite color is green',
        confidence: 0.85,
        importance: 0.5,
        validFrom: t2,
        validTo: null,
        recordedAt: seedAt,
        embedding: vec(0.1),
        entityIds: [],
      });
    });
    await container.ingestion.supersede({ oldId, newId: newId_, reason: 'contradiction' });

    const recallAt = async (asOf?: string): Promise<string[]> => {
      const res = await app.inject({
        method: 'GET',
        url: `/recall?q=favorite%20color${asOf ? `&asOf=${encodeURIComponent(asOf)}` : ''}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      return (res.json().data.facts as Array<{ id: string }>).map((f) => f.id);
    };

    const historical = await recallAt('2024-03-01T00:00:00.000Z');
    expect(historical).toContain(oldId);
    expect(historical).not.toContain(newId_);

    const current = await recallAt();
    expect(current).toContain(newId_);
    expect(current).not.toContain(oldId);

    // …and the unranked snapshot agrees.
    const timeline = await app.inject({
      method: 'GET',
      url: '/timeline?at=2024-03-01T00:00:00.000Z',
      headers: auth,
    });
    expect(timeline.statusCode).toBe(200);
    const timelineIds = (timeline.json().data.facts as Array<{ id: string }>).map((f) => f.id);
    expect(timelineIds).toContain(oldId);
    expect(timelineIds).not.toContain(newId_);
  });

  test('recall asOf holds preferences to the same instant as facts', async () => {
    const first = await app.inject({
      method: 'PUT',
      url: '/preferences/coffee',
      headers: auth,
      payload: { value: 'drip', confidence: 0.9 },
    });
    expect(first.statusCode).toBe(200);
    // Both versions are stamped from wall clock; separate them so the as-of
    // instant lands unambiguously inside the first version's interval.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const betweenVersions = new Date();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await app.inject({
      method: 'PUT',
      url: '/preferences/coffee',
      headers: auth,
      payload: { value: 'espresso', confidence: 0.9 },
    });
    expect(second.statusCode).toBe(200);

    const values = async (asOf?: string): Promise<string[]> => {
      const res = await app.inject({
        method: 'GET',
        url: `/recall?q=coffee&includePreferences=true${
          asOf ? `&asOf=${encodeURIComponent(asOf)}` : ''
        }`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      return ((res.json().data.preferences ?? []) as Array<{ value: string }>).map((p) => p.value);
    };

    expect(await values()).toContain('espresso');
    // A historical as-of must answer with the value that held then, not today's.
    const historical = await values(betweenVersions.toISOString());
    expect(historical).toContain('drip');
    expect(historical).not.toContain('espresso');
  });

  test('preference set stamps recordedAt; intention inherits episode time', async () => {
    const epTs = '2022-11-11T11:11:11.000Z';
    const episodeId = await postEpisode({
      rawTranscript: 'remind me later',
      timestamp: epTs,
    });

    const pref = await app.inject({
      method: 'PUT',
      url: '/preferences/coffee',
      headers: auth,
      payload: { value: 'espresso', confidence: 0.9 },
    });
    expect(pref.statusCode).toBe(200);
    expect(pref.json().data.recordedAt).toBeTruthy();
    expect(pref.json().data.validFrom).toBeTruthy();

    const intention = await app.inject({
      method: 'POST',
      url: '/intentions',
      headers: auth,
      payload: {
        content: 'follow up on registration',
        triggerHint: 'when the user next mentions DMV',
        sourceEpisodeId: episodeId,
      },
    });
    expect(intention.statusCode).toBe(200);
    expect(intention.json().data.validFrom).toBe(epTs);
    expect(new Date(intention.json().data.createdAt as string).getTime()).toBeGreaterThan(
      new Date(epTs).getTime(),
    );
  });
});
