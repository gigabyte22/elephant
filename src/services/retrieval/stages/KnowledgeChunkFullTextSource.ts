import type { RetrievalStage } from '../types.ts';
import { knowledgeChunkSourceConfig } from './KnowledgeChunkVectorSource.ts';
import { createChunkFullTextSource } from './chunk-source-factory.ts';

export function KnowledgeChunkFullTextSource(): RetrievalStage {
  return createChunkFullTextSource(knowledgeChunkSourceConfig);
}
