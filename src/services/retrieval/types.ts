// Core types for the retrieval pipeline.
// Stages are pure async functions over (RetrievalContext, PipelineState).
// State is threaded as a mutable bag of Maps for O(1) upserts across stages.

import type {
  Chunk,
  Entity,
  Fact,
  Insight,
  Intention,
  KnowledgeChunk,
  MemoryKind,
  Preference,
  Procedure,
  Research,
  ScopeMode,
} from '../../models/types.ts';
import type { RetrievalConfig } from './config.ts';

export type CandidateSource =
  | 'fact_vector'
  | 'fact_fulltext'
  | 'chunk_vector'
  | 'chunk_fulltext'
  | 'preference_vector'
  | 'insight_vector'
  | 'knowledge_chunk_vector'
  | 'knowledge_chunk_fulltext'
  | 'procedure_vector'
  | 'procedure_fulltext'
  | 'research_vector'
  | 'intention_vector'
  | 'entity_sibling'
  | 'entity_ppr'
  | 'chunk_derived'
  | 'chunk_neighbor'
  | 'rerank';

export interface RecallQuery {
  q: string;
  agentId?: string;
  sessionId?: string;
  agentScope?: ScopeMode;
  sessionScope?: ScopeMode;
  // v1.2: cross-cutting scope axes.
  projectId?: string;
  userId?: string;
  projectScope?: ScopeMode;
  userScope?: ScopeMode;
  // v1.2: restrict to a subset of memory categories. Default = facts only,
  // matching pre-v1.2 behavior unless callers opt in to wider categories.
  kinds?: MemoryKind[];
  from?: Date;
  to?: Date;
  minImportance?: number;
  minConfidence?: number;
  limit?: number;
  includeSuperseded?: boolean;
  entityId?: string;
  includeChunks?: boolean;
  includePreferences?: boolean;
  includeInsights?: boolean;
  // v1.2: opt-in inclusion of new categories.
  includeKnowledge?: boolean;
  includeProcedures?: boolean;
  includeResearch?: boolean;
  // Opt-in: surface pending intentions ("open commitments") in recall. Off by
  // default — intentions are operational, not knowledge.
  includeIntentions?: boolean;
  rerank?: boolean;
  // Opt-in Personalized PageRank retrieval for this query (overrides the env
  // default RETRIEVAL_ENABLE_PPR, same pattern as `rerank`).
  ppr?: boolean;
  debug?: boolean;
  chunkNeighborRadius?: number;
  now?: Date;
}

export interface RetrievalContext {
  query: RecallQuery;
  queryVector: number[];
  ftQuery: string;
  now: Date;
  config: RetrievalConfig;
  stageTimingsMs: Record<string, number>;
  limit: number;
  // Entity ids the query linked to (QueryEntityLinkStage), used as PPR seeds.
  queryEntityIds?: string[];
}

interface RankedSource {
  source: CandidateSource;
  rank: number;
  rawScore?: number;
}

export interface FactCandidate {
  fact: Fact;
  sources: RankedSource[];
  fusedScore?: number;
  blendedScore?: number;
  rerankScore?: number;
  expansionReason: CandidateSource;
  originAgentId?: string | null;
  originSessionId?: string | null;
  hasDirectHit: boolean;
}

export interface ChunkCandidate {
  chunk: Chunk;
  sources: RankedSource[];
  fusedScore?: number;
  blendedScore?: number;
  expansionReason: CandidateSource;
}

export interface PreferenceCandidate {
  preference: Preference;
  rawScore: number;
  fusedScore?: number;
  blendedScore?: number;
}

export interface InsightCandidate {
  insight: Insight;
  rawScore: number;
  fusedScore?: number;
  blendedScore?: number;
}

export interface KnowledgeChunkCandidate {
  chunk: KnowledgeChunk;
  sources: RankedSource[];
  fusedScore?: number;
  blendedScore?: number;
  expansionReason: CandidateSource;
}

export interface ProcedureCandidate {
  procedure: Procedure;
  sources: RankedSource[];
  fusedScore?: number;
  blendedScore?: number;
  expansionReason: CandidateSource;
}

export interface ResearchCandidate {
  research: Research;
  rawScore: number;
  fusedScore?: number;
  blendedScore?: number;
}

export interface IntentionCandidate {
  intention: Intention;
  rawScore: number;
  fusedScore?: number;
  blendedScore?: number;
}

export interface PipelineState {
  facts: Map<string, FactCandidate>;
  chunks: Map<string, ChunkCandidate>;
  preferences: Map<string, PreferenceCandidate>;
  insights: Map<string, InsightCandidate>;
  entities: Map<string, Entity>;
  knowledgeChunks: Map<string, KnowledgeChunkCandidate>;
  procedures: Map<string, ProcedureCandidate>;
  research: Map<string, ResearchCandidate>;
  intentions: Map<string, IntentionCandidate>;
}

export function emptyState(): PipelineState {
  return {
    facts: new Map(),
    chunks: new Map(),
    preferences: new Map(),
    insights: new Map(),
    entities: new Map(),
    knowledgeChunks: new Map(),
    procedures: new Map(),
    research: new Map(),
    intentions: new Map(),
  };
}

export interface RetrievalStage {
  name: string;
  run(ctx: RetrievalContext, state: PipelineState): Promise<PipelineState>;
}

export interface Pipeline {
  run(ctx: RetrievalContext): Promise<PipelineState>;
}

export interface RecallResult {
  facts: Array<
    Fact & {
      score: number;
      expansionReason: CandidateSource;
      originAgentId?: string | null;
      originSessionId?: string | null;
    }
  >;
  entities: Entity[];
  chunks?: Array<Chunk & { score: number; expansionReason: CandidateSource }>;
  preferences?: Array<Preference & { score: number }>;
  insights?: Array<Insight & { score: number }>;
  knowledgeChunks?: Array<KnowledgeChunk & { score: number; expansionReason: CandidateSource }>;
  procedures?: Array<Procedure & { score: number; expansionReason: CandidateSource }>;
  research?: Array<Research & { score: number }>;
  intentions?: Array<Intention & { score: number }>;
  trace?: {
    stageTimingsMs: Record<string, number>;
    rerankUsed: boolean;
    candidatesSeen: {
      facts: number;
      chunks: number;
      preferences: number;
      insights: number;
      knowledgeChunks: number;
      procedures: number;
      research: number;
    };
  };
}
