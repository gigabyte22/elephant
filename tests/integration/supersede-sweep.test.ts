// POST /facts no longer waits on a contradiction check.
//
// The check itself is a vector search plus an LLM call, and it used to run
// inline on every explicit fact write — on the same provider the dream cycle
// uses, so an orchestrator writing facts and the dreamer queued behind each
// other. The write now leaves the fact unchecked and the dreamer's supersede
// sweep claims it, which is only sound if the sweep actually closes the
// contradictions the inline path would have. That is what these pin.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import type { Fact } from '../../src/models/types.ts';
import { FactRepository } from '../../src/repositories/FactRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const PROJECT = 'proj-sweep';

// The two facts contradict; the fake supersede judge below closes the old one
// whenever it sees the new one.
const OLD_CLAIM = 'The user prefers dark mode in the editor';
const NEW_CLAIM = 'The user prefers light mode in the editor';

let container: Container;
let supersedeCalls: Array<{ candidate: string; existing: string[] }>;
/** Makes the judge unavailable, standing in for a model outage mid-sweep. */
let supersedeThrows = false;

beforeAll(async () => {
  supersedeCalls = [];
  container = await bootstrap({
    embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
    llm: createFakeLLMAdapter({
      supersede: ({ candidate, existing }) => {
        supersedeCalls.push({
          candidate: candidate.content,
          existing: existing.map((e) => e.content),
        });
        if (supersedeThrows) throw new Error('judge unavailable');
        const old = existing.find((e) => e.content === OLD_CLAIM);
        return old
          ? { oldFactId: old.id, reason: 'preference reversed', confidenceDelta: 0.1 }
          : null;
      },
    }),
  });
});

afterAll(async () => {
  await shutdown();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  supersedeCalls = [];
  supersedeThrows = false;
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

async function writeFact(
  content: string,
  scope: { projectId?: string; userId?: string } = { projectId: PROJECT },
): Promise<Fact> {
  return container.ingestion.saveFact({ content, category: 'preference', ...scope });
}

/** Backdate a fact past the sweep's settling grace period. */
async function age(id: string): Promise<void> {
  await txWrite((tx) =>
    tx.run('MATCH (f:Fact {id: $id}) SET f.recordedAt = datetime() - duration({minutes: 5})', {
      id,
    }),
  );
}

async function getFact(id: string): Promise<Fact | null> {
  return read((tx) => FactRepository.get(tx, id));
}

describe('POST /facts in dream mode', () => {
  test('writes without calling the LLM', async () => {
    await writeFact(OLD_CLAIM);
    await writeFact(NEW_CLAIM);

    // The whole point: the write path is LLM-free. This is the assertion that
    // fails if supersede-on-write is ever reinstated by default.
    expect(supersedeCalls).toEqual([]);
  });

  test('leaves the fact marked unchecked for the sweep to claim', async () => {
    const fact = await writeFact(OLD_CLAIM);
    expect((await getFact(fact.id))?.supersedeCheckedAt ?? null).toBeNull();
  });
});

describe('the dream supersede sweep', () => {
  test('closes a contradiction the write path skipped, at event time', async () => {
    const old = await writeFact(OLD_CLAIM);
    const fresh = await writeFact(NEW_CLAIM);
    await age(old.id);
    await age(fresh.id);

    const run = await container.dreaming.runCycle();

    expect(supersedeCalls.length).toBeGreaterThan(0);
    expect(run.factsSupersedeSwept).toBe(2);
    expect(run.factsSuperseded).toBe(1);

    const closed = await getFact(old.id);
    expect(closed?.validTo).not.toBeNull();
    // Event time, not wall clock: the claim stopped holding when the newer one
    // started, which is what the bi-temporal contract promises.
    expect(closed?.validTo?.getTime()).toBe(fresh.validFrom.getTime());

    const survivor = await getFact(fresh.id);
    expect(survivor?.validTo).toBeNull();
  });

  test('stamps checked facts so a later cycle does not re-examine them', async () => {
    const fact = await writeFact('The user works in Berlin');
    await age(fact.id);

    await container.dreaming.runCycle();
    const stamped = await getFact(fact.id);
    expect(stamped?.supersedeCheckedAt).toBeInstanceOf(Date);

    // A second cycle has nothing left to sweep — otherwise every stored fact
    // would cost an LLM call every night, forever.
    supersedeCalls = [];
    const second = await container.dreaming.runCycle();
    expect(second.factsSupersedeSwept).toBe(0);
    expect(supersedeCalls).toEqual([]);
  });

  test('leaves a fact whose check threw unstamped, so the next cycle retries it', async () => {
    // Stamping is what retires a fact from the queue, so a check that never
    // reached a verdict must not stamp — otherwise one model outage silently
    // drops the contradiction forever.
    const old = await writeFact(OLD_CLAIM);
    const fresh = await writeFact(NEW_CLAIM);
    await age(old.id);
    await age(fresh.id);

    supersedeThrows = true;
    await container.dreaming.runCycle();
    expect((await getFact(old.id))?.validTo ?? null).toBeNull();

    supersedeThrows = false;
    supersedeCalls = [];
    const retried = await container.dreaming.runCycle();

    // Contrast with the stamping test above, where a second cycle asks nothing.
    expect(supersedeCalls.length).toBeGreaterThan(0);
    expect(retried.factsSuperseded).toBe(1);
    expect((await getFact(old.id))?.validTo).not.toBeNull();
  });

  test("never closes one user's fact from another user's contradiction", async () => {
    // Two humans, contradictory personal claims, same unscoped bucket. Before
    // the userId guard covered every dedupScope branch, ravi's fact superseded
    // dana's — the LLM judge saw them side by side with nothing saying they
    // belong to different people.
    const danaFact = await writeFact(OLD_CLAIM, { userId: 'dana' });
    const raviFact = await writeFact(NEW_CLAIM, { userId: 'ravi' });
    await age(danaFact.id);
    await age(raviFact.id);

    await container.dreaming.runCycle();

    expect((await getFact(danaFact.id))?.validTo).toBeNull();
    expect((await getFact(raviFact.id))?.validTo).toBeNull();
    // The judge must never even see dana's claim among another user's candidates.
    for (const call of supersedeCalls) {
      expect(call.existing).not.toContain(OLD_CLAIM);
    }
  });

  test("a user's fact still supersedes a shared null-user fact", async () => {
    const sharedFact = await writeFact(OLD_CLAIM, {});
    const raviFact = await writeFact(NEW_CLAIM, { userId: 'ravi' });
    await age(sharedFact.id);
    await age(raviFact.id);

    const run = await container.dreaming.runCycle();

    expect(run.factsSuperseded).toBe(1);
    expect((await getFact(sharedFact.id))?.validTo).not.toBeNull();
    expect((await getFact(raviFact.id))?.validTo).toBeNull();
  });

  test("a user's contradiction still closes their own earlier fact", async () => {
    const old = await writeFact(OLD_CLAIM, { userId: 'dana' });
    const fresh = await writeFact(NEW_CLAIM, { userId: 'dana' });
    await age(old.id);
    await age(fresh.id);

    const run = await container.dreaming.runCycle();

    expect(run.factsSuperseded).toBe(1);
    expect((await getFact(old.id))?.validTo).not.toBeNull();
  });

  test('leaves facts written moments ago for the next cycle', async () => {
    // An orchestrator writing a batch would otherwise have its first fact
    // judged against siblings that have not landed yet.
    const fact = await writeFact('The user just said something');

    const run = await container.dreaming.runCycle();

    expect(run.factsSupersedeSwept).toBe(0);
    expect((await getFact(fact.id))?.supersedeCheckedAt ?? null).toBeNull();
  });
});
