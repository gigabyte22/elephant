// Sequential pipeline runner. Each stage transforms PipelineState and the
// runner records per-stage timings on the context. Stages are expected to
// resolve quickly — any cross-stage parallelism should happen inside a stage.

import type { EmbeddingAdapter } from '../../adapters/embeddings/types.ts';
import type { LLMAdapter } from '../../adapters/llm/types.ts';
import { AgentOriginAnnotationStage } from './stages/AgentOriginAnnotationStage.ts';
import { BlendedScoringStage } from './stages/BlendedScoringStage.ts';
import { ChunkFullTextSource } from './stages/ChunkFullTextSource.ts';
import { ChunkNeighborExpansionStage } from './stages/ChunkNeighborExpansionStage.ts';
import { ChunkToFactProjector } from './stages/ChunkToFactProjector.ts';
import { ChunkVectorSource } from './stages/ChunkVectorSource.ts';
import { EntitySiblingExpansionStage } from './stages/EntitySiblingExpansionStage.ts';
import { FactFullTextSource } from './stages/FactFullTextSource.ts';
import { FactVectorSource } from './stages/FactVectorSource.ts';
import { GraphPprStage } from './stages/GraphPprStage.ts';
import { HydrateEntitiesStage } from './stages/HydrateEntitiesStage.ts';
import { InsightVectorSource } from './stages/InsightVectorSource.ts';
import { IntentionVectorSource } from './stages/IntentionVectorSource.ts';
import { KnowledgeChunkFullTextSource } from './stages/KnowledgeChunkFullTextSource.ts';
import { KnowledgeChunkVectorSource } from './stages/KnowledgeChunkVectorSource.ts';
import { LlmRerankStage } from './stages/LlmRerankStage.ts';
import { PostFilterStage } from './stages/PostFilterStage.ts';
import { PreferenceVectorSource } from './stages/PreferenceVectorSource.ts';
import { ProcedureFullTextSource } from './stages/ProcedureFullTextSource.ts';
import { ProcedureVectorSource } from './stages/ProcedureVectorSource.ts';
import { QueryEntityLinkStage } from './stages/QueryEntityLinkStage.ts';
import { QueryPreparerStage } from './stages/QueryPreparerStage.ts';
import { RefCountTickStage } from './stages/RefCountTickStage.ts';
import { ResearchChunkFullTextSource } from './stages/ResearchChunkFullTextSource.ts';
import { ResearchChunkVectorSource } from './stages/ResearchChunkVectorSource.ts';
import { ResearchVectorSource } from './stages/ResearchVectorSource.ts';
import { RrfFusionStage } from './stages/RrfFusionStage.ts';
import { TopKStage } from './stages/TopKStage.ts';
import {
  type Pipeline,
  type PipelineState,
  type RetrievalContext,
  type RetrievalStage,
  emptyState,
} from './types.ts';

export function composePipeline(stages: RetrievalStage[]): Pipeline {
  return {
    async run(ctx: RetrievalContext): Promise<PipelineState> {
      let state = emptyState();
      for (const stage of stages) {
        const start = performance.now();
        state = await stage.run(ctx, state);
        ctx.stageTimingsMs[stage.name] = performance.now() - start;
      }
      return state;
    },
  };
}

export interface PipelineDeps {
  embedder: EmbeddingAdapter;
  llm: LLMAdapter;
}

export function buildDefaultRetrievalPipeline(deps: PipelineDeps): Pipeline {
  return composePipeline([
    QueryPreparerStage(deps.embedder),
    // PPR-only; no-op unless PPR is enabled. Links the query to entities here
    // so GraphPprStage can seed from them alongside the dense/FT hits.
    QueryEntityLinkStage(),
    FactVectorSource(),
    FactFullTextSource(),
    ChunkVectorSource(),
    ChunkFullTextSource(),
    PreferenceVectorSource(),
    InsightVectorSource(),
    // v1.2 sources — gated by query.includeKnowledge / includeProcedures /
    // includeResearch so callers don't pay vector-index costs unless they
    // opted in.
    KnowledgeChunkVectorSource(),
    KnowledgeChunkFullTextSource(),
    ProcedureVectorSource(),
    ProcedureFullTextSource(),
    ResearchVectorSource(),
    ResearchChunkVectorSource(),
    ResearchChunkFullTextSource(),
    IntentionVectorSource(),
    ChunkToFactProjector(),
    // PPR-only; adds an `entity_ppr` source list that RrfFusion then blends.
    GraphPprStage(deps.llm),
    RrfFusionStage(),
    EntitySiblingExpansionStage(),
    ChunkNeighborExpansionStage(),
    AgentOriginAnnotationStage(),
    PostFilterStage(),
    BlendedScoringStage(),
    LlmRerankStage(deps.llm),
    TopKStage(),
    HydrateEntitiesStage(),
    RefCountTickStage(),
  ]);
}
