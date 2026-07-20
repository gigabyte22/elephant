// Public composition root. Builds the dependency graph from env so callers
// (HTTP server, CLI scripts, integration tests) get one wired-up bag of services.

import type { EmbeddingAdapter } from './adapters/embeddings/types.ts';
import type { ExtractionService } from './adapters/extraction/types.ts';
import {
  buildBlobStore,
  buildEmbeddingAdapter,
  buildExtractionService,
  buildLLMAdapter,
  buildVaultWriter,
  buildWorkingStateAdapter,
} from './adapters/factory.ts';
import type { LLMAdapter } from './adapters/llm/types.ts';
import type { BlobStore } from './adapters/storage/types.ts';
import type { VaultWriter } from './adapters/vault/types.ts';
import type { WorkingStateAdapter } from './adapters/working-state/types.ts';
import type { Env } from './config/env.ts';
import { loadEnv } from './config/env.ts';
import { closeDriver, verifyConnectivity } from './config/neo4j.ts';
import { type DashboardService, createDashboardService } from './services/DashboardService.ts';
import { type DreamingService, createDreamingService } from './services/DreamingService.ts';
import { type IntentionService, createIntentionService } from './services/IntentionService.ts';
import {
  type KnowledgeIngestionService,
  createKnowledgeIngestionService,
} from './services/KnowledgeIngestionService.ts';
import {
  type MemoryIngestionService,
  createMemoryIngestionService,
} from './services/MemoryIngestionService.ts';
import {
  type ObservationService,
  createObservationService,
} from './services/ObservationService.ts';
import { type PreferenceService, createPreferenceService } from './services/PreferenceService.ts';
import { type ProcedureService, createProcedureService } from './services/ProcedureService.ts';
import { type ResearchService, createResearchService } from './services/ResearchService.ts';
import { type RetrievalService, createRetrievalService } from './services/RetrievalService.ts';
import { type TemporalService, createTemporalService } from './services/TemporalService.ts';
import {
  type WorkingStateService,
  createWorkingStateService,
} from './services/WorkingStateService.ts';
import {
  type GraphProjectionService,
  createGraphProjectionService,
} from './services/graph/GraphProjectionService.ts';
import { buildRetrievalConfigFromEnv } from './services/retrieval/config.ts';
import { buildDefaultRetrievalPipeline } from './services/retrieval/pipeline.ts';
import type { Pipeline } from './services/retrieval/types.ts';

export interface Container {
  env: Env;
  llm: LLMAdapter;
  embedder: EmbeddingAdapter;
  blobStore: BlobStore;
  vault?: VaultWriter;
  extraction: ExtractionService;
  ingestion: MemoryIngestionService;
  retrieval: RetrievalService;
  temporal: TemporalService;
  preferences: PreferenceService;
  observations: ObservationService;
  dreaming: DreamingService;
  graphProjection: GraphProjectionService;
  knowledge: KnowledgeIngestionService;
  procedures: ProcedureService;
  intentions: IntentionService;
  research: ResearchService;
  workingState: WorkingStateService;
  workingStateAdapter: WorkingStateAdapter;
  dashboard: DashboardService;
}

export interface ContainerOverrides {
  llm?: LLMAdapter;
  embedder?: EmbeddingAdapter;
  retrievalPipeline?: Pipeline;
  workingStateAdapter?: WorkingStateAdapter;
  vault?: VaultWriter;
}

export async function buildContainer(overrides: ContainerOverrides = {}): Promise<Container> {
  const env = loadEnv();
  const llm = overrides.llm ?? buildLLMAdapter(env);
  const embedder = overrides.embedder ?? buildEmbeddingAdapter(env);
  const workingStateAdapter =
    overrides.workingStateAdapter ?? (await buildWorkingStateAdapter(env));

  if (embedder.dim !== env.EMBED_DIM) {
    throw new Error(
      `Embedding adapter dim (${embedder.dim}) does not match EMBED_DIM (${env.EMBED_DIM}). Re-run scripts/migrate.ts after fixing EMBED_DIM, or pick an adapter whose dim matches.`,
    );
  }

  const sharedConfig = {
    chunkTargetTokens: env.CHUNK_TARGET_TOKENS,
    chunkOverlapTokens: env.CHUNK_OVERLAP_TOKENS,
    summaryThresholdTokens: env.SUMMARY_THRESHOLD_TOKENS,
    summaryTargetTokens: env.SUMMARY_TARGET_TOKENS,
    embedderMaxInputTokens: env.EMBED_MAX_INPUT_TOKENS,
  };

  const blobStore = buildBlobStore(env);
  const vault = overrides.vault ?? buildVaultWriter(env);
  const extraction = buildExtractionService(env);
  const graphProjection = createGraphProjectionService();

  return {
    env,
    llm,
    embedder,
    blobStore,
    vault,
    extraction,
    ingestion: createMemoryIngestionService({ llm, embedder, config: sharedConfig }),
    retrieval: createRetrievalService({
      pipeline: overrides.retrievalPipeline ?? buildDefaultRetrievalPipeline({ embedder, llm }),
      config: buildRetrievalConfigFromEnv(env),
    }),
    temporal: createTemporalService(),
    preferences: createPreferenceService({ embedder }),
    observations: createObservationService({ embedder, ttlDays: env.MEMORY_OBSERVATION_TTL_DAYS }),
    dreaming: createDreamingService({
      llm,
      embedder,
      graphProjection,
      config: {
        maxEpisodesPerRun: env.DREAM_MAX_EPISODES_PER_RUN,
        deadlineMs: env.DREAM_DEADLINE_MS,
        enableRelationExtraction: env.DREAM_ENABLE_RELATION_EXTRACTION,
        relationMinConfidence: env.DREAM_RELATION_MIN_CONFIDENCE,
        enableEntityResolution: env.DREAM_ENABLE_ENTITY_RESOLUTION,
        synonymThreshold: env.DREAM_ENTITY_SYNONYM_THRESHOLD,
        synonymCandidates: env.DREAM_ENTITY_SYNONYM_CANDIDATES,
        refreshProjection: env.RETRIEVAL_ENABLE_PPR,
        dedupThreshold: env.DREAM_DEDUP_THRESHOLD,
        supersedeVectorThreshold: env.DREAM_SUPERSEDE_VECTOR_THRESHOLD,
        promoteInsightImportance: env.DREAM_PROMOTE_INSIGHT_IMPORTANCE,
        crossScopeDedup: env.DREAM_CROSS_SCOPE_DEDUP,
        pruneWindowDays: env.DREAM_PRUNE_WINDOW_DAYS,
        pruneBatchLimit: env.DREAM_PRUNE_BATCH_LIMIT,
        pruneImportanceExempt: env.DREAM_PRUNE_IMPORTANCE_EXEMPT,
        pruneRetentionFloor: env.DREAM_PRUNE_RETENTION_FLOOR,
        enableConsolidation: env.DREAM_ENABLE_CONSOLIDATION,
        consolidationMaxClustersPerRun: env.DREAM_CONSOLIDATION_MAX_CLUSTERS_PER_RUN,
        consolidationMaxClusterSize: env.DREAM_CONSOLIDATION_MAX_CLUSTER_SIZE,
        consolidationMinSimilarity: env.DREAM_CONSOLIDATION_MIN_SIMILARITY,
        consolidationMinEntityFacts: env.DREAM_CONSOLIDATION_MIN_ENTITY_FACTS,
      },
    }),
    graphProjection,
    knowledge: createKnowledgeIngestionService({
      llm,
      embedder,
      blobStore,
      extraction,
      vault,
      config: { ...sharedConfig, maxAttachmentBytes: env.KNOWLEDGE_MAX_ATTACHMENT_BYTES },
    }),
    procedures: createProcedureService({
      embedder,
      config: { embedderMaxInputTokens: env.EMBED_MAX_INPUT_TOKENS },
    }),
    intentions: createIntentionService({
      embedder,
      config: { embedderMaxInputTokens: env.EMBED_MAX_INPUT_TOKENS },
    }),
    research: createResearchService({ llm, embedder, vault, config: sharedConfig }),
    workingState: createWorkingStateService({ adapter: workingStateAdapter }),
    workingStateAdapter,
    dashboard: createDashboardService({
      prune: {
        importanceExempt: env.DREAM_PRUNE_IMPORTANCE_EXEMPT,
        minWindowDays: env.DREAM_PRUNE_WINDOW_DAYS,
        retentionFloor: env.DREAM_PRUNE_RETENTION_FLOOR,
      },
    }),
  };
}

export async function bootstrap(overrides?: ContainerOverrides): Promise<Container> {
  await verifyConnectivity();
  return buildContainer(overrides);
}

export async function shutdown(): Promise<void> {
  await closeDriver();
}

export type { Env } from './config/env.ts';
export type { EmbeddingAdapter } from './adapters/embeddings/types.ts';
export type { LLMAdapter } from './adapters/llm/types.ts';
export type { WorkingStateAdapter } from './adapters/working-state/types.ts';
export * from './models/types.ts';
export * from './models/wire.ts';
