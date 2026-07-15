import { describe, expect, test } from 'vitest';
import type { Fact } from '../../src/models/types.ts';
import { AgentOriginAnnotationStage } from '../../src/services/retrieval/stages/AgentOriginAnnotationStage.ts';
import { PostFilterStage } from '../../src/services/retrieval/stages/PostFilterStage.ts';
import type { FactCandidate } from '../../src/services/retrieval/types.ts';
import { makeCtx, makeFact, makeState } from './retrieval-fixtures.ts';

function makeCandidate(
  fact: Fact,
  originAgentId?: string | null,
  originSessionId?: string | null,
): FactCandidate {
  return {
    fact,
    sources: [],
    expansionReason: 'fact_vector',
    hasDirectHit: true,
    originAgentId,
    originSessionId,
  };
}

describe('AgentOriginAnnotationStage — direct-write scope fallback', () => {
  // Facts here carry no sourceEpisodeId, so the stage never touches Neo4j.
  test('fact-level agentId/sessionId flow into origin fields when there is no source episode', async () => {
    const state = makeState([
      makeCandidate(makeFact({ id: 'direct', agentId: 'alpha', sessionId: 's1' })),
      makeCandidate(makeFact({ id: 'unscoped' })),
    ]);
    await AgentOriginAnnotationStage().run(makeCtx(), state);
    const direct = state.facts.get('direct')!;
    expect(direct.originAgentId).toBe('alpha');
    expect(direct.originSessionId).toBe('s1');
    const unscoped = state.facts.get('unscoped')!;
    expect(unscoped.originAgentId).toBeNull();
    expect(unscoped.originSessionId).toBeNull();
  });

  test('direct-write facts participate in agentScope=filter via the fallback', async () => {
    const state = makeState([
      makeCandidate(makeFact({ id: 'alpha-direct', agentId: 'alpha' })),
      makeCandidate(makeFact({ id: 'beta-direct', agentId: 'beta' })),
    ]);
    const ctx = makeCtx({ query: { agentId: 'alpha', agentScope: 'filter' } });
    await AgentOriginAnnotationStage().run(ctx, state);
    await PostFilterStage().run(ctx, state);
    expect(Array.from(state.facts.keys())).toEqual(['alpha-direct']);
  });
});

describe('PostFilterStage — agent/session scope', () => {
  test('agentScope=filter drops non-matching origin but keeps null-origin (shared) facts', async () => {
    const state = makeState([
      makeCandidate(makeFact({ id: 'alpha-own' }), 'alpha', 's1'),
      makeCandidate(makeFact({ id: 'beta-foreign' }), 'beta', 's2'),
      makeCandidate(makeFact({ id: 'shared' }), null, null),
    ]);
    const ctx = makeCtx({ query: { agentId: 'alpha', agentScope: 'filter' } });
    await PostFilterStage().run(ctx, state);
    const ids = Array.from(state.facts.keys()).sort();
    expect(ids).toEqual(['alpha-own', 'shared']);
  });

  test('agentScope=boost keeps all facts regardless of origin', async () => {
    const state = makeState([
      makeCandidate(makeFact({ id: 'alpha-own' }), 'alpha', 's1'),
      makeCandidate(makeFact({ id: 'beta-foreign' }), 'beta', 's2'),
      makeCandidate(makeFact({ id: 'shared' }), null, null),
    ]);
    const ctx = makeCtx({ query: { agentId: 'alpha', agentScope: 'boost' } });
    await PostFilterStage().run(ctx, state);
    expect(state.facts.size).toBe(3);
  });

  test('no agentId set → scope is effectively none (keep all)', async () => {
    const state = makeState([
      makeCandidate(makeFact({ id: 'a' }), 'alpha', 's1'),
      makeCandidate(makeFact({ id: 'b' }), 'beta', 's2'),
    ]);
    // agentScope='filter' provided but no agentId → no filtering.
    const ctx = makeCtx({ query: { agentScope: 'filter' } });
    await PostFilterStage().run(ctx, state);
    expect(state.facts.size).toBe(2);
  });

  test('agentScope=filter drops chunks / preferences / insights for cross-agent safety', async () => {
    const state = makeState([makeCandidate(makeFact({ id: 'alpha-own' }), 'alpha', 's1')]);
    // Seed non-fact collections so we can verify they're cleared.
    state.chunks.set('c1', {
      chunk: {
        id: 'c1',
        episodeId: 'e1',
        position: 0,
        text: 'x',
        tokenCount: 1,
        embedding: [],
        createdAt: new Date(),
      },
      sources: [],
      expansionReason: 'chunk_vector',
    });
    const ctx = makeCtx({ query: { agentId: 'alpha', agentScope: 'filter' } });
    await PostFilterStage().run(ctx, state);
    expect(state.chunks.size).toBe(0);
  });

  test('importance / confidence / temporal filters still apply', async () => {
    const low = makeCandidate(makeFact({ id: 'low' }));
    low.fact.importance = 0.2;
    const high = makeCandidate(makeFact({ id: 'high' }));
    high.fact.importance = 0.9;
    const state = makeState([low, high]);
    const ctx = makeCtx({ query: { minImportance: 0.5 } });
    await PostFilterStage().run(ctx, state);
    expect(Array.from(state.facts.keys())).toEqual(['high']);
  });
});
