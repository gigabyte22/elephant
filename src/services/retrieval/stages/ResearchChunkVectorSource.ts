import type { ResearchChunk } from '../../../models/types.ts';
import { ResearchChunkRepository } from '../../../repositories/ResearchChunkRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { type ChunkSourceConfig, createChunkVectorSource } from './chunk-source-factory.ts';
import { upsertFusedChunkHits } from './helpers.ts';

export const researchChunkSourceConfig: ChunkSourceConfig<ResearchChunk> = {
  vectorStageName: 'ResearchChunkVectorSource',
  fulltextStageName: 'ResearchChunkFullTextSource',
  vectorSource: 'research_chunk_vector',
  fulltextSource: 'research_chunk_fulltext',
  // Research is project-scoped — same gate as ResearchVectorSource: skip
  // without a projectId to avoid returning cross-project artifacts.
  gate: (ctx) => ctx.query.includeResearch === true && Boolean(ctx.query.projectId),
  repo: ResearchChunkRepository,
  upsert: (state, hits, source) => upsertFusedChunkHits(state.researchChunks, hits, source),
};

export function ResearchChunkVectorSource(): RetrievalStage {
  return createChunkVectorSource(researchChunkSourceConfig);
}
