// Typed config for the retrieval pipeline. Built once at container bootstrap
// from env vars; pipeline stages read from RetrievalContext.config.

import type { Env } from '../../config/env.ts';

export interface ScoringWeights {
  rrf: number;
  importance: number;
  confidence: number;
  recency: number;
  refCount: number;
}

export interface RerankConfig {
  enabled: boolean;
  topK: number;
  keepK: number;
}

export interface ChunkFusionConfig {
  enabled: boolean;
}

export interface SiblingExpansionConfig {
  enabled: boolean;
  budget: number;
}

export interface AgentScopeBoosts {
  ownAgent: number;
  sameSession: number;
}

// Personalized PageRank retrieval (HippoRAG-style). Disabled by default — when
// off, the GraphPpr / QueryEntityLink stages early-return and the recall
// pipeline is unchanged.
export interface PprConfig {
  enabled: boolean;
  // Max PPR-ranked facts pulled into the candidate set.
  budget: number;
  // Seed PPR from the entities of the top-N dense/FT candidate facts.
  seedTopFacts: number;
  // Max query→entity links used as additional PPR seeds.
  queryEntityLinks: number;
  dampingFactor: number;
  maxIterations: number;
  // Score damp applied to pure-PPR (non-direct-hit) facts in blended scoring.
  blendDamp: number;
  useRecognitionFilter: boolean;
}

export interface RetrievalConfig {
  weights: ScoringWeights;
  rrfK: number;
  rerank: RerankConfig;
  chunks: ChunkFusionConfig;
  siblings: SiblingExpansionConfig;
  ppr: PprConfig;
  chunkNeighborRadius: number;
  halfLifeDays: number;
  boosts: AgentScopeBoosts;
  refCountTickMode: 'async' | 'sync' | 'off';
  overfetchMultiplier: number;
}

export function buildRetrievalConfigFromEnv(env: Env): RetrievalConfig {
  return {
    weights: {
      rrf: env.RETRIEVAL_WEIGHT_RRF,
      importance: env.RETRIEVAL_WEIGHT_IMPORTANCE,
      confidence: env.RETRIEVAL_WEIGHT_CONFIDENCE,
      recency: env.RETRIEVAL_WEIGHT_RECENCY,
      refCount: env.RETRIEVAL_WEIGHT_REF_COUNT,
    },
    rrfK: env.RETRIEVAL_RRF_K,
    rerank: {
      enabled: env.RETRIEVAL_ENABLE_RERANK,
      topK: env.RETRIEVAL_RERANK_TOP_K,
      keepK: env.RETRIEVAL_RERANK_KEEP_K,
    },
    chunks: { enabled: env.RETRIEVAL_ENABLE_CHUNKS },
    siblings: {
      enabled: env.RETRIEVAL_ENABLE_SIBLING_EXPANSION,
      budget: env.RETRIEVAL_SIBLING_BUDGET,
    },
    ppr: {
      enabled: env.RETRIEVAL_ENABLE_PPR,
      budget: env.RETRIEVAL_PPR_BUDGET,
      seedTopFacts: env.RETRIEVAL_PPR_SEED_TOP_FACTS,
      queryEntityLinks: env.RETRIEVAL_PPR_QUERY_ENTITY_LINKS,
      dampingFactor: env.RETRIEVAL_PPR_DAMPING,
      maxIterations: env.RETRIEVAL_PPR_MAX_ITER,
      blendDamp: env.RETRIEVAL_PPR_DAMP_FACTOR,
      useRecognitionFilter: env.RETRIEVAL_PPR_USE_RECOGNITION_FILTER,
    },
    chunkNeighborRadius: env.RETRIEVAL_CHUNK_NEIGHBOR_RADIUS,
    halfLifeDays: env.RETRIEVAL_RECENCY_HALF_LIFE_DAYS,
    boosts: {
      ownAgent: env.RETRIEVAL_OWN_AGENT_BOOST,
      sameSession: env.RETRIEVAL_SAME_SESSION_BOOST,
    },
    refCountTickMode: env.RETRIEVAL_REFCOUNT_TICK_MODE,
    overfetchMultiplier: env.RETRIEVAL_OVERFETCH_MULTIPLIER,
  };
}
