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
  describeExtractionCapabilities,
} from './adapters/factory.ts';
import type { LLMAdapter } from './adapters/llm/types.ts';
import type { BlobStore } from './adapters/storage/types.ts';
import type { VaultWriter } from './adapters/vault/types.ts';
import type { WorkingStateAdapter } from './adapters/working-state/types.ts';
import type { Env } from './config/env.ts';
import { loadEnv } from './config/env.ts';
import { closeDriver, verifyConnectivity, write } from './config/neo4j.ts';
import { DreamRunRepository } from './repositories/DreamRunRepository.ts';
import { createDashboardService, type DashboardService } from './services/DashboardService.ts';
import { createDreamingService, type DreamingService } from './services/DreamingService.ts';
import {
  createGraphProjectionService,
  type GraphProjectionService,
} from './services/graph/GraphProjectionService.ts';
import { createIntentionService, type IntentionService } from './services/IntentionService.ts';
import {
  createKnowledgeIngestionService,
  type KnowledgeIngestionService,
} from './services/KnowledgeIngestionService.ts';
import {
  createMemoryIngestionService,
  type MemoryIngestionService,
} from './services/MemoryIngestionService.ts';
import {
  createObservationService,
  type ObservationService,
} from './services/ObservationService.ts';
import { createPreferenceService, type PreferenceService } from './services/PreferenceService.ts';
import { createProcedureService, type ProcedureService } from './services/ProcedureService.ts';
import { createResearchService, type ResearchService } from './services/ResearchService.ts';
import { createRetrievalService, type RetrievalService } from './services/RetrievalService.ts';
import { buildRetrievalConfigFromEnv } from './services/retrieval/config.ts';
import { buildDefaultRetrievalPipeline } from './services/retrieval/pipeline.ts';
import type { Pipeline } from './services/retrieval/types.ts';
import { createTemporalService, type TemporalService } from './services/TemporalService.ts';
import {
  createWorkingStateService,
  type WorkingStateService,
} from './services/WorkingStateService.ts';

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
  // Injectable so attachment paths can be exercised without a blob directory or
  // a live vision/transcription provider.
  extraction?: ExtractionService;
  blobStore?: BlobStore;
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

  const blobStore = overrides.blobStore ?? buildBlobStore(env);
  const vault = overrides.vault ?? buildVaultWriter(env);
  const extraction = overrides.extraction ?? buildExtractionService(env);
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
        maxDreamAttempts: env.DREAM_MAX_ATTEMPTS,
        retryBackoffBaseMs: env.DREAM_RETRY_BACKOFF_BASE_MS,
        enableRelationExtraction: env.DREAM_ENABLE_RELATION_EXTRACTION,
        relationMinConfidence: env.DREAM_RELATION_MIN_CONFIDENCE,
        enableEntityResolution: env.DREAM_ENABLE_ENTITY_RESOLUTION,
        synonymThreshold: env.DREAM_ENTITY_SYNONYM_THRESHOLD,
        synonymCandidates: env.DREAM_ENTITY_SYNONYM_CANDIDATES,
        refreshProjection: env.RETRIEVAL_ENABLE_PPR,
        dedupThreshold: env.DREAM_DEDUP_THRESHOLD,
        supersedeVectorThreshold: env.DREAM_SUPERSEDE_VECTOR_THRESHOLD,
        promoteInsightImportance: env.DREAM_PROMOTE_INSIGHT_IMPORTANCE,
        insightDedupThreshold: env.DREAM_INSIGHT_DEDUP_THRESHOLD,
        insightRetireBatchLimit: env.DREAM_INSIGHT_RETIRE_BATCH_LIMIT,
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
      config: {
        ...sharedConfig,
        maxAttachmentBytes: env.KNOWLEDGE_MAX_ATTACHMENT_BYTES,
      },
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
  const container = await buildContainer(overrides);
  // Announce where attachments go. Silence here is what let a key set for
  // dreaming quietly become the OCR provider for every uploaded image.
  if (!overrides?.extraction) {
    for (const line of describeExtractionCapabilities(container.env)) {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }
  await reconcileStaleDreamRuns(container.env.DREAM_DEADLINE_MS);
  return container;
}

// A dream cycle that died with its process leaves its DreamRun row at
// 'running' forever. Reap those at boot, but only past a generous multiple of
// the soft deadline: the deadline is checked between episodes, and the
// consolidate/promote/prune passes run after it, so a healthy long run can
// legitimately overshoot. Best-effort — a failed reap must not block startup.
async function reconcileStaleDreamRuns(deadlineMs: number): Promise<void> {
  const staleAfterMs = Math.max(deadlineMs * 4, 60 * 60_000);
  try {
    const reaped = await write((tx) =>
      DreamRunRepository.failStaleRunning(tx, new Date(Date.now() - staleAfterMs)),
    );
    if (reaped > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[bootstrap] marked ${reaped} abandoned dream run(s) as failed`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[bootstrap] could not reconcile stale dream runs', err);
  }
}

export async function shutdown(): Promise<void> {
  await closeDriver();
}

export type { EmbeddingAdapter } from './adapters/embeddings/types.ts';
export type { LLMAdapter } from './adapters/llm/types.ts';
export type { WorkingStateAdapter } from './adapters/working-state/types.ts';
export type { Env } from './config/env.ts';
export * from './models/types.ts';
export * from './models/wire.ts';
