// Session working-memory observations in hybrid recall. The source stage is
// hard-scoped to one session in Cypher; these cover the guards that sit either
// side of it — the opt-in gate, the post-filter, and the blend.

import { describe, expect, test } from 'vitest';
import { BlendedScoringStage } from '../../src/services/retrieval/stages/BlendedScoringStage.ts';
import { ObservationVectorSource } from '../../src/services/retrieval/stages/ObservationVectorSource.ts';
import { PostFilterStage } from '../../src/services/retrieval/stages/PostFilterStage.ts';
import { RrfFusionStage } from '../../src/services/retrieval/stages/RrfFusionStage.ts';
import { makeCtx, makeObservationCandidate, makeState } from './retrieval-fixtures.ts';

function stateWith(candidates: ReturnType<typeof makeObservationCandidate>[]) {
  return makeState([], {
    observations: new Map(candidates.map((c) => [c.observation.id, c])),
  });
}

describe('ObservationVectorSource — opt-in gate', () => {
  // Both branches must return before touching `read()`, so an un-opted-in
  // recall never pays the vector-index cost. A DB call here would throw:
  // there is no driver in unit tests.
  test('no-ops without includeObservations', async () => {
    const state = makeState([]);
    await ObservationVectorSource().run(makeCtx({ query: { sessionId: 's1' } }), state);
    expect(state.observations.size).toBe(0);
  });

  test('no-ops without a sessionId', async () => {
    const state = makeState([]);
    await ObservationVectorSource().run(makeCtx({ query: { includeObservations: true } }), state);
    expect(state.observations.size).toBe(0);
  });
});

describe('PostFilterStage — observations', () => {
  test('kinds is a hard filter', async () => {
    const state = stateWith([makeObservationCandidate({ id: 'o1' })]);
    await PostFilterStage().run(makeCtx({ query: { kinds: ['fact'] } }), state);
    expect(state.observations.size).toBe(0);
  });

  test('kinds including observation keeps them', async () => {
    const state = stateWith([makeObservationCandidate({ id: 'o1' })]);
    await PostFilterStage().run(makeCtx({ query: { kinds: ['fact', 'observation'] } }), state);
    expect(state.observations.size).toBe(1);
  });

  // Observations carry a required agentId, so they get a row-level filter
  // rather than the blanket drop the origin-less categories take.
  test('agentScope=filter keeps only this agent, and does not clear the map', async () => {
    const state = stateWith([
      makeObservationCandidate({ id: 'mine', agentId: 'alpha' }),
      makeObservationCandidate({ id: 'theirs', agentId: 'beta' }),
    ]);
    await PostFilterStage().run(
      makeCtx({ query: { agentId: 'alpha', agentScope: 'filter' } }),
      state,
    );
    expect([...state.observations.keys()]).toEqual(['mine']);
  });

  test('projectScope=strict drops unscoped observations', async () => {
    const state = stateWith([
      makeObservationCandidate({ id: 'scoped', projectId: 'p1' }),
      makeObservationCandidate({ id: 'global' }),
    ]);
    const ctx = makeCtx({ query: { projectId: 'p1', projectScope: 'strict' } });
    await PostFilterStage().run(ctx, state);
    expect([...state.observations.keys()]).toEqual(['scoped']);
  });
});

describe('observation blending', () => {
  test('ranks by similarity, not by recency', async () => {
    // The stale observation is the better semantic match but three half-lives
    // old; the fresh one is nearly as similar and a day old. Recall exists to
    // reach the tail the session's token budget already evicted, so similarity
    // has to win — the fresh one is probably still in the context window.
    // These scores are chosen to straddle: an extra recency multiplier of 1.5x
    // flips this ordering, so the assertion pins the weighting, not just sort.
    const state = stateWith([
      makeObservationCandidate({ id: 'stale', recordedAt: new Date('2026-01-01') }, 0.9),
      makeObservationCandidate({ id: 'fresh', recordedAt: new Date('2026-03-31') }, 0.79),
    ]);
    const ctx = makeCtx();
    await RrfFusionStage().run(ctx, state);
    await BlendedScoringStage().run(ctx, state);
    const stale = state.observations.get('stale')!.blendedScore!;
    const fresh = state.observations.get('fresh')!.blendedScore!;
    expect(stale).toBeGreaterThan(fresh);
  });

  test('stays on the same 0..1 scale as the other categories', async () => {
    const state = stateWith([
      makeObservationCandidate({ id: 'top', recordedAt: new Date('2026-04-01') }, 1),
    ]);
    const ctx = makeCtx();
    await RrfFusionStage().run(ctx, state);
    await BlendedScoringStage().run(ctx, state);
    expect(state.observations.get('top')!.blendedScore!).toBeLessThanOrEqual(1);
  });
});
