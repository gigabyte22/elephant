// Shared test fixtures for retrieval-pipeline unit tests. The default config
// mirrors src/services/retrieval/config.ts's dev defaults closely enough that
// per-test overrides stay small.

import type { Fact } from '../../src/models/types.ts';
import type {
  FactCandidate,
  PipelineState,
  RetrievalContext,
} from '../../src/services/retrieval/types.ts';

export function makeFact(partial: Partial<Fact> & { id: string }): Fact {
  return {
    id: partial.id,
    content: partial.content ?? `fact ${partial.id}`,
    confidence: partial.confidence ?? 0.8,
    importance: partial.importance ?? 0.5,
    validFrom: partial.validFrom ?? new Date('2026-01-01'),
    validTo: partial.validTo ?? null,
    recordedAt: partial.recordedAt ?? new Date('2026-01-01'),
    embedding: partial.embedding ?? [],
    entityIds: partial.entityIds ?? [],
    referenceCount: partial.referenceCount ?? 0,
    lastReferencedAt: partial.lastReferencedAt ?? null,
    sourceEpisodeId: partial.sourceEpisodeId,
    supersedesFactId: partial.supersedesFactId,
    category: partial.category,
  };
}

export function makeCtx(
  overrides: {
    query?: Partial<RetrievalContext['query']>;
    config?: Partial<RetrievalContext['config']>;
  } = {},
): RetrievalContext {
  return {
    query: { q: 'x', ...overrides.query },
    queryVector: [],
    ftQuery: '',
    now: new Date('2026-04-01'),
    limit: 10,
    stageTimingsMs: {},
    config: {
      weights: { rrf: 0.5, importance: 0.2, confidence: 0.1, recency: 0.1, refCount: 0.1 },
      rrfK: 60,
      rerank: { enabled: false, topK: 20, keepK: 10 },
      chunks: { enabled: true },
      siblings: { enabled: true, budget: 20 },
      ppr: {
        enabled: false,
        budget: 30,
        seedTopFacts: 10,
        queryEntityLinks: 5,
        dampingFactor: 0.85,
        maxIterations: 20,
        blendDamp: 0.5,
        useRecognitionFilter: false,
      },
      chunkNeighborRadius: 1,
      halfLifeDays: 30,
      boosts: { ownAgent: 1.15, sameSession: 1.05 },
      refCountTickMode: 'off',
      overfetchMultiplier: 3,
      ...overrides.config,
    },
  };
}

export function makeState(
  facts: FactCandidate[],
  extras: Partial<PipelineState> = {},
): PipelineState {
  return {
    facts: new Map(facts.map((c) => [c.fact.id, c])),
    chunks: extras.chunks ?? new Map(),
    preferences: extras.preferences ?? new Map(),
    insights: extras.insights ?? new Map(),
    entities: extras.entities ?? new Map(),
    knowledgeChunks: extras.knowledgeChunks ?? new Map(),
    procedures: extras.procedures ?? new Map(),
    research: extras.research ?? new Map(),
    intentions: extras.intentions ?? new Map(),
  };
}
