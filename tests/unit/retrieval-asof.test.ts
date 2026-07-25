// Valid-time as-of filtering in the retrieval pipeline. The source stages push
// the same predicate into Cypher, but expansion paths (chunk→fact projection,
// entity siblings, PPR) bypass those queries entirely — PostFilterStage is what
// holds every path to one instant, so that's what these cover.

import { describe, expect, test } from 'vitest';
import { PostFilterStage } from '../../src/services/retrieval/stages/PostFilterStage.ts';
import { asOfOverfetchLimit } from '../../src/services/retrieval/stages/helpers.ts';
import type { FactCandidate } from '../../src/services/retrieval/types.ts';
import { makeCtx, makeFact, makePreferenceCandidate, makeState } from './retrieval-fixtures.ts';

// ctx.now in the fixtures is 2026-04-01.
const JAN = new Date('2026-01-01');
const FEB = new Date('2026-02-01');
const JUN = new Date('2026-06-01');

function candidate(fact: ReturnType<typeof makeFact>): FactCandidate {
  return { fact, sources: [], expansionReason: 'fact_vector', hasDirectHit: true };
}

describe('PostFilterStage — fact valid-time', () => {
  test('by default drops facts closed before now', async () => {
    const state = makeState([
      candidate(makeFact({ id: 'live', validFrom: JAN, validTo: null })),
      candidate(makeFact({ id: 'closed', validFrom: JAN, validTo: FEB })),
    ]);
    await PostFilterStage().run(makeCtx(), state);
    expect([...state.facts.keys()]).toEqual(['live']);
  });

  test('by default drops facts whose validFrom has not arrived', async () => {
    const state = makeState([
      candidate(makeFact({ id: 'future', validFrom: JUN, validTo: null })),
      candidate(makeFact({ id: 'live', validFrom: JAN, validTo: null })),
    ]);
    await PostFilterStage().run(makeCtx(), state);
    expect([...state.facts.keys()]).toEqual(['live']);
  });

  test('explicit asOf returns the claim that held then, not the current one', async () => {
    const state = makeState([
      candidate(makeFact({ id: 'old', validFrom: JAN, validTo: FEB })),
      candidate(makeFact({ id: 'new', validFrom: FEB, validTo: null })),
    ]);
    await PostFilterStage().run(makeCtx({ query: { asOf: new Date('2026-01-15') } }), state);
    expect([...state.facts.keys()]).toEqual(['old']);
  });

  test('interval is half-open — validTo is exclusive', async () => {
    const state = makeState([candidate(makeFact({ id: 'f', validFrom: JAN, validTo: FEB }))]);
    await PostFilterStage().run(makeCtx({ query: { asOf: FEB } }), state);
    expect(state.facts.size).toBe(0);
  });

  test('includeSuperseded without asOf keeps both open and closed intervals', async () => {
    const state = makeState([
      candidate(makeFact({ id: 'live', validFrom: JAN, validTo: null })),
      candidate(makeFact({ id: 'closed', validFrom: JAN, validTo: FEB })),
    ]);
    await PostFilterStage().run(makeCtx({ query: { includeSuperseded: true } }), state);
    expect([...state.facts.keys()].sort()).toEqual(['closed', 'live']);
  });

  test('explicit asOf still applies under includeSuperseded', async () => {
    const state = makeState([
      candidate(makeFact({ id: 'old', validFrom: JAN, validTo: FEB })),
      candidate(makeFact({ id: 'new', validFrom: FEB, validTo: null })),
    ]);
    const ctx = makeCtx({ query: { includeSuperseded: true, asOf: new Date('2026-01-15') } });
    await PostFilterStage().run(ctx, state);
    expect([...state.facts.keys()]).toEqual(['old']);
  });
});

describe('PostFilterStage — preference valid-time', () => {
  // Without this, a historical recall answers with today's preference values
  // alongside correctly-aged facts.
  test('asOf selects the preference version that held then', async () => {
    const state = makeState([], {
      preferences: new Map([
        ['old', makePreferenceCandidate({ id: 'old', validFrom: JAN, validTo: FEB })],
        ['new', makePreferenceCandidate({ id: 'new', validFrom: FEB, validTo: null })],
      ]),
    });
    await PostFilterStage().run(makeCtx({ query: { asOf: new Date('2026-01-15') } }), state);
    expect([...state.preferences.keys()]).toEqual(['old']);
  });

  test('defaults to the live version', async () => {
    const state = makeState([], {
      preferences: new Map([
        ['old', makePreferenceCandidate({ id: 'old', validFrom: JAN, validTo: FEB })],
        ['new', makePreferenceCandidate({ id: 'new', validFrom: FEB, validTo: null })],
      ]),
    });
    await PostFilterStage().run(makeCtx(), state);
    expect([...state.preferences.keys()]).toEqual(['new']);
  });
});

describe('asOfOverfetchLimit', () => {
  // Neo4j's vector index picks its top-K before our valid-time predicate runs,
  // so a historical as-of needs a wider K or the filter empties the result.
  test('widens the candidate window for a historical asOf', () => {
    const ctx = makeCtx();
    expect(asOfOverfetchLimit(ctx, JAN)).toBe(ctx.limit * 3 * 4);
  });

  test('leaves the window alone for as-of now, the default', () => {
    const ctx = makeCtx();
    expect(asOfOverfetchLimit(ctx, ctx.now)).toBe(ctx.limit * 3);
  });

  test('leaves the window alone when there is no interval filter at all', () => {
    const ctx = makeCtx();
    expect(asOfOverfetchLimit(ctx, null)).toBe(ctx.limit * 3);
  });
});
