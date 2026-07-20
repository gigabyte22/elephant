import { describe, expect, test } from 'vitest';
import type { Chunk, ResearchChunk } from '../../src/models/types.ts';
import { RrfFusionStage } from '../../src/services/retrieval/stages/RrfFusionStage.ts';
import type { FactCandidate, PipelineState } from '../../src/services/retrieval/types.ts';
import { makeCtx, makeFact, makeState } from './retrieval-fixtures.ts';

describe('RrfFusionStage', () => {
  test('facts present in multiple source lists rank higher than single-source facts', async () => {
    const state: PipelineState = {
      facts: new Map<string, FactCandidate>([
        [
          'both',
          {
            fact: makeFact({ id: 'both' }),
            sources: [
              { source: 'fact_vector', rank: 0 },
              { source: 'fact_fulltext', rank: 0 },
            ],
            expansionReason: 'fact_vector',
            hasDirectHit: true,
          },
        ],
        [
          'vec-only',
          {
            fact: makeFact({ id: 'vec-only' }),
            sources: [{ source: 'fact_vector', rank: 0 }],
            expansionReason: 'fact_vector',
            hasDirectHit: true,
          },
        ],
        [
          'ft-only',
          {
            fact: makeFact({ id: 'ft-only' }),
            sources: [{ source: 'fact_fulltext', rank: 0 }],
            expansionReason: 'fact_fulltext',
            hasDirectHit: true,
          },
        ],
      ]),
      chunks: new Map(),
      preferences: new Map(),
      insights: new Map(),
      entities: new Map(),
      knowledgeChunks: new Map(),
      procedures: new Map(),
      research: new Map(),
      researchChunks: new Map(),
      intentions: new Map(),
    };
    await RrfFusionStage().run(makeCtx(), state);
    expect(state.facts.get('both')!.fusedScore!).toBeGreaterThan(
      state.facts.get('vec-only')!.fusedScore!,
    );
    expect(state.facts.get('both')!.fusedScore!).toBeGreaterThan(
      state.facts.get('ft-only')!.fusedScore!,
    );
  });

  test('chunk fusion: chunks in both chunk_vector and chunk_fulltext rank higher', async () => {
    const makeChunk = (id: string): Chunk => ({
      id,
      episodeId: 'ep',
      position: 0,
      text: `chunk ${id}`,
      tokenCount: 1,
      embedding: [],
      createdAt: new Date(),
    });
    const state: PipelineState = {
      facts: new Map(),
      chunks: new Map([
        [
          'both',
          {
            chunk: makeChunk('both'),
            sources: [
              { source: 'chunk_vector', rank: 0 },
              { source: 'chunk_fulltext', rank: 0 },
            ],
            expansionReason: 'chunk_vector',
          },
        ],
        [
          'solo',
          {
            chunk: makeChunk('solo'),
            sources: [{ source: 'chunk_vector', rank: 0 }],
            expansionReason: 'chunk_vector',
          },
        ],
      ]),
      preferences: new Map(),
      insights: new Map(),
      entities: new Map(),
      knowledgeChunks: new Map(),
      procedures: new Map(),
      research: new Map(),
      researchChunks: new Map(),
      intentions: new Map(),
    };
    await RrfFusionStage().run(makeCtx(), state);
    expect(state.chunks.get('both')!.fusedScore!).toBeGreaterThan(
      state.chunks.get('solo')!.fusedScore!,
    );
  });

  test('research chunk fusion: chunks in both vector and fulltext lists rank higher', async () => {
    const makeResearchChunk = (id: string): ResearchChunk => ({
      id: `00000000-0000-4000-8000-00000000000${id}`,
      researchId: '00000000-0000-4000-8000-0000000000ff',
      position: 0,
      text: `research chunk ${id}`,
      tokenCount: 1,
      embedding: [],
      createdAt: new Date(),
      projectId: 'proj',
    });
    const state = makeState([], {
      researchChunks: new Map([
        [
          'both',
          {
            chunk: makeResearchChunk('1'),
            sources: [
              { source: 'research_chunk_vector', rank: 0 },
              { source: 'research_chunk_fulltext', rank: 0 },
            ],
            expansionReason: 'research_chunk_vector',
          },
        ],
        [
          'solo',
          {
            chunk: makeResearchChunk('2'),
            sources: [{ source: 'research_chunk_vector', rank: 0 }],
            expansionReason: 'research_chunk_vector',
          },
        ],
      ]),
    });
    await RrfFusionStage().run(makeCtx(), state);
    expect(state.researchChunks.get('both')!.fusedScore!).toBeGreaterThan(
      state.researchChunks.get('solo')!.fusedScore!,
    );
  });

  test('preferences/insights: fusedScore = rawScore (single-source)', async () => {
    const state: PipelineState = {
      facts: new Map(),
      chunks: new Map(),
      preferences: new Map([
        [
          'p1',
          {
            preference: {
              id: 'p1',
              key: 'theme',
              value: 'dark',
              confidence: 0.9,
              validFrom: new Date('2026-01-01'),
              validTo: null,
              embedding: [],
            },
            rawScore: 0.7,
          },
        ],
      ]),
      insights: new Map([
        [
          'i1',
          {
            insight: {
              id: 'i1',
              content: 'insight',
              embedding: [],
              promotedFromFactIds: [],
              createdAt: new Date('2026-01-01'),
            },
            rawScore: 0.65,
          },
        ],
      ]),
      entities: new Map(),
      knowledgeChunks: new Map(),
      procedures: new Map(),
      research: new Map(),
      researchChunks: new Map(),
      intentions: new Map(),
    };
    await RrfFusionStage().run(makeCtx(), state);
    expect(state.preferences.get('p1')!.fusedScore).toBe(0.7);
    expect(state.insights.get('i1')!.fusedScore).toBe(0.65);
  });
});
