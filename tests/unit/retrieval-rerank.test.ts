import { describe, expect, test } from 'vitest';
import { createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { LlmRerankStage } from '../../src/services/retrieval/stages/LlmRerankStage.ts';
import { makeCtx, makeFact, makeState } from './retrieval-fixtures.ts';

function rerankCtx(overrides: { rerankEnabled?: boolean; rerankInQuery?: boolean } = {}) {
  return makeCtx({
    query: { q: 'find the best', rerank: overrides.rerankInQuery },
    config: { rerank: { enabled: overrides.rerankEnabled ?? true, topK: 5, keepK: 3 } },
  });
}

describe('LlmRerankStage', () => {
  test('query.rerank=true overrides env disabled (per-query opt-in)', async () => {
    const llm = createFakeLLMAdapter({
      rerank: ({ candidates }) => candidates.map((c, i) => ({ id: c.id, score: 1 - i * 0.1 })),
    });
    const state = makeState([
      {
        fact: makeFact({ id: 'a' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        blendedScore: 0.8,
      },
    ]);
    const stage = LlmRerankStage(llm);
    await stage.run(rerankCtx({ rerankEnabled: false, rerankInQuery: true }), state);
    expect(state.facts.get('a')!.rerankScore).toBeDefined();
  });

  test('no-op when both env and query say off', async () => {
    const llm = createFakeLLMAdapter({
      rerank: () => {
        throw new Error('should not be called');
      },
    });
    const state = makeState([
      {
        fact: makeFact({ id: 'a' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        blendedScore: 0.8,
      },
    ]);
    const stage = LlmRerankStage(llm);
    await stage.run(rerankCtx({ rerankEnabled: false, rerankInQuery: undefined }), state);
    expect(state.facts.get('a')!.rerankScore).toBeUndefined();
  });

  test('no-op when query.rerank = false even if enabled', async () => {
    const llm = createFakeLLMAdapter({
      rerank: () => {
        throw new Error('should not be called');
      },
    });
    const state = makeState([
      {
        fact: makeFact({ id: 'a' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        blendedScore: 0.8,
      },
    ]);
    const stage = LlmRerankStage(llm);
    await stage.run(rerankCtx({ rerankEnabled: true, rerankInQuery: false }), state);
    expect(state.facts.get('a')!.rerankScore).toBeUndefined();
  });

  test('identity rerank preserves order; no fact is flagged rerank_promoted', async () => {
    const llm = createFakeLLMAdapter({
      rerank: ({ candidates }) => candidates.map((c, i) => ({ id: c.id, score: 1 - i * 0.1 })),
    });
    const state = makeState([
      {
        fact: makeFact({ id: 'a' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        blendedScore: 0.9,
      },
      {
        fact: makeFact({ id: 'b' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        blendedScore: 0.6,
      },
    ]);
    const stage = LlmRerankStage(llm);
    await stage.run(rerankCtx({ rerankEnabled: true, rerankInQuery: true }), state);
    expect(state.facts.get('a')!.rerankScore).toBeGreaterThan(state.facts.get('b')!.rerankScore!);
    expect(state.facts.get('a')!.expansionReason).toBe('fact_vector');
    expect(state.facts.get('b')!.expansionReason).toBe('fact_vector');
  });

  test('promotion flagged when a lower-ranked fact moves above a higher one', async () => {
    const llm = createFakeLLMAdapter({
      rerank: ({ candidates }) =>
        // Swap first two: b goes first.
        [
          { id: candidates[1]!.id, score: 0.95 },
          { id: candidates[0]!.id, score: 0.4 },
        ],
    });
    const state = makeState([
      {
        fact: makeFact({ id: 'a' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        blendedScore: 0.9,
      },
      {
        fact: makeFact({ id: 'b' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        blendedScore: 0.6,
      },
    ]);
    const stage = LlmRerankStage(llm);
    await stage.run(rerankCtx({ rerankEnabled: true, rerankInQuery: true }), state);
    expect(state.facts.get('b')!.expansionReason).toBe('rerank');
  });

  test('no-op when LLM adapter has no rerank method', async () => {
    const llmNoRerank = {
      ...createFakeLLMAdapter(),
      rerank: undefined,
    };
    const state = makeState([
      {
        fact: makeFact({ id: 'a' }),
        sources: [],
        expansionReason: 'fact_vector',
        hasDirectHit: true,
        blendedScore: 0.8,
      },
    ]);
    const stage = LlmRerankStage(llmNoRerank);
    await stage.run(rerankCtx({ rerankEnabled: true, rerankInQuery: true }), state);
    expect(state.facts.get('a')!.rerankScore).toBeUndefined();
  });
});
