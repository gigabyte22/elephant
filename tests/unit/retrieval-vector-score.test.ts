// `vectorScore` on recall results — the raw similarity behind the blended rank.
//
// Why it exists: `score` cannot answer "is this good enough to use". RRF
// replaces similarity magnitude with reciprocal rank, and the blend then
// normalises the top hit against the best in the set, so the first result of a
// nonsense query scores about the same as the first result of a perfect one. A
// client that wants to show nothing rather than the least-bad match has nothing
// to threshold on. These pin that the pre-fusion number survives to the caller.

import { describe, expect, test } from 'vitest';
import {
  createRetrievalService,
  type RetrievalService,
} from '../../src/services/RetrievalService.ts';
import type { Pipeline, PipelineState } from '../../src/services/retrieval/types.ts';
import { makeCtx, makeFact, makeObservation, makeState } from './retrieval-fixtures.ts';

const CONFIG = makeCtx().config;

// Drives the service with a prepared state, so these test the PROJECTION
// rather than re-testing the stages that filled it in.
function serviceOver(state: PipelineState): RetrievalService {
  const pipeline: Pipeline = { run: async () => state };
  return createRetrievalService({ pipeline, config: CONFIG });
}

describe('recall vectorScore', () => {
  test('carries the vector source rawScore through fusion and blending', async () => {
    const state = makeState([
      {
        fact: makeFact({ id: 'a' }),
        // Two sources fused: the vector one holds the comparable magnitude.
        sources: [
          { source: 'fact_vector', rank: 0, rawScore: 0.83 },
          { source: 'fact_fulltext', rank: 3, rawScore: 11.2 },
        ],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        blendedScore: 0.9,
      },
    ]);
    const [fact] = (await serviceOver(state).recall({ q: 'x' })).facts;
    expect(fact!.vectorScore).toBe(0.83);
    // The blended score is untouched — this is additive.
    expect(fact!.score).toBe(0.9);
  });

  test('is absent when nothing vector-shaped produced the hit', async () => {
    // A fulltext-only hit, a sibling, a chunk neighbour or a PageRank expansion
    // has no similarity behind it. Reporting 0 would read as "maximally
    // dissimilar" and get thresholded away; absent means "cannot say".
    const state = makeState([
      {
        fact: makeFact({ id: 'ft' }),
        sources: [{ source: 'fact_fulltext', rank: 0, rawScore: 9.4 }],
        expansionReason: 'fact_fulltext',
        hasDirectHit: true,
        blendedScore: 0.7,
      },
      {
        fact: makeFact({ id: 'sib' }),
        sources: [],
        expansionReason: 'entity_sibling',
        hasDirectHit: false,
        blendedScore: 0.4,
      },
    ]);
    const { facts } = await serviceOver(state).recall({ q: 'x' });
    expect(facts.find((f) => f.id === 'ft')!.vectorScore).toBeUndefined();
    expect(facts.find((f) => f.id === 'sib')!.vectorScore).toBeUndefined();
  });

  test('single-source kinds report their own rawScore', async () => {
    // Observations, preferences, insights, research and intentions are
    // vector-only by construction, so they carry the similarity directly
    // rather than in a fusion list.
    const state = makeState([], {
      observations: new Map([
        ['o1', { observation: makeObservation({ id: 'o1' }), rawScore: 0.61, blendedScore: 0.55 }],
      ]),
    });
    const result = await serviceOver(state).recall({ q: 'x', includeObservations: true });
    expect(result.observations?.[0]?.vectorScore).toBe(0.61);
  });

  test('survives a query that matched nothing', async () => {
    const result = await serviceOver(makeState([])).recall({ q: 'x' });
    expect(result.facts).toEqual([]);
  });
});
