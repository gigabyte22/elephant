import { describe, expect, test } from 'vitest';
import { BlendedScoringStage } from '../../src/services/retrieval/stages/BlendedScoringStage.ts';
import { makeCtx, makeFact, makeState } from './retrieval-fixtures.ts';

describe('BlendedScoringStage', () => {
  test('higher fused score + better signals → higher blended score', async () => {
    const stage = BlendedScoringStage();
    const state = makeState([
      {
        fact: makeFact({ id: 'a', importance: 0.9, confidence: 0.9, referenceCount: 10 }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
      },
      {
        fact: makeFact({ id: 'b', importance: 0.1, confidence: 0.1, referenceCount: 0 }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 0.5,
      },
    ]);
    await stage.run(makeCtx(), state);
    expect(state.facts.get('a')!.blendedScore!).toBeGreaterThan(
      state.facts.get('b')!.blendedScore!,
    );
  });

  test('sibling expansion damps to 0.5× (direct match with same signals scores higher)', async () => {
    const stage = BlendedScoringStage();
    const state = makeState([
      {
        fact: makeFact({ id: 'direct' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
      },
      {
        fact: makeFact({ id: 'sibling' }),
        sources: [],
        expansionReason: 'entity_sibling',
        hasDirectHit: false,
        fusedScore: 1.0,
      },
    ]);
    await stage.run(makeCtx(), state);
    const direct = state.facts.get('direct')!.blendedScore!;
    const sibling = state.facts.get('sibling')!.blendedScore!;
    expect(sibling).toBeLessThan(direct);
    expect(sibling / direct).toBeCloseTo(0.5, 1);
  });

  test('chunk_derived without a direct hit damps to 0.8×', async () => {
    const stage = BlendedScoringStage();
    const state = makeState([
      {
        fact: makeFact({ id: 'direct' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
      },
      {
        fact: makeFact({ id: 'projected' }),
        sources: [],
        expansionReason: 'chunk_derived',
        hasDirectHit: false,
        fusedScore: 1.0,
      },
    ]);
    await stage.run(makeCtx(), state);
    expect(
      state.facts.get('projected')!.blendedScore! / state.facts.get('direct')!.blendedScore!,
    ).toBeCloseTo(0.8, 1);
  });

  test('own-agent boost applied when originAgentId matches query.agentId', async () => {
    const stage = BlendedScoringStage();
    const state = makeState([
      {
        fact: makeFact({ id: 'own' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
        originAgentId: 'alpha',
      },
      {
        fact: makeFact({ id: 'other' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
        originAgentId: 'beta',
      },
    ]);
    await stage.run(makeCtx({ query: { agentId: 'alpha' } }), state);
    expect(state.facts.get('own')!.blendedScore!).toBeGreaterThan(
      state.facts.get('other')!.blendedScore!,
    );
    expect(
      state.facts.get('own')!.blendedScore! / state.facts.get('other')!.blendedScore!,
    ).toBeCloseTo(1.15, 2);
  });

  test('null originAgentId receives no boost (treated as shared)', async () => {
    const stage = BlendedScoringStage();
    const state = makeState([
      {
        fact: makeFact({ id: 'own' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
        originAgentId: 'alpha',
      },
      {
        fact: makeFact({ id: 'shared' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
        originAgentId: null,
      },
    ]);
    await stage.run(makeCtx({ query: { agentId: 'alpha' } }), state);
    expect(state.facts.get('own')!.blendedScore!).toBeGreaterThan(
      state.facts.get('shared')!.blendedScore!,
    );
  });

  test('same-session boost compounds with agent boost', async () => {
    const stage = BlendedScoringStage();
    const state = makeState([
      {
        fact: makeFact({ id: 'both' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
        originAgentId: 'alpha',
        originSessionId: 's1',
      },
      {
        fact: makeFact({ id: 'agent-only' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
        originAgentId: 'alpha',
        originSessionId: 's2',
      },
    ]);
    await stage.run(makeCtx({ query: { agentId: 'alpha', sessionId: 's1' } }), state);
    const both = state.facts.get('both')!.blendedScore!;
    const agentOnly = state.facts.get('agent-only')!.blendedScore!;
    expect(both / agentOnly).toBeCloseTo(1.05, 2);
  });

  test('recency decay: recent facts score higher than ancient ones with identical signals', async () => {
    const stage = BlendedScoringStage();
    const state = makeState([
      {
        fact: makeFact({ id: 'recent', recordedAt: new Date('2026-04-01') }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
      },
      {
        fact: makeFact({ id: 'old', recordedAt: new Date('2024-01-01') }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        fusedScore: 1.0,
      },
    ]);
    await stage.run(makeCtx(), state);
    expect(state.facts.get('recent')!.blendedScore!).toBeGreaterThan(
      state.facts.get('old')!.blendedScore!,
    );
  });
});
