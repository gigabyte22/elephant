import type { KnowledgeChunk } from '../../../models/types.ts';
import { KnowledgeChunkRepository } from '../../../repositories/KnowledgeChunkRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { type ChunkSourceConfig, createChunkVectorSource } from './chunk-source-factory.ts';
import { upsertFusedChunkHits } from './helpers.ts';

export const knowledgeChunkSourceConfig: ChunkSourceConfig<KnowledgeChunk> = {
  vectorStageName: 'KnowledgeChunkVectorSource',
  fulltextStageName: 'KnowledgeChunkFullTextSource',
  vectorSource: 'knowledge_chunk_vector',
  fulltextSource: 'knowledge_chunk_fulltext',
  gate: (ctx) => ctx.query.includeKnowledge === true,
  repo: KnowledgeChunkRepository,
  upsert: (state, hits, source) => upsertFusedChunkHits(state.knowledgeChunks, hits, source),
};

export function KnowledgeChunkVectorSource(): RetrievalStage {
  return createChunkVectorSource(knowledgeChunkSourceConfig);
}
