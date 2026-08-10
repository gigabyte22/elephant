import type { RetrievalStage } from '../types.ts';
import { createChunkFullTextSource } from './chunk-source-factory.ts';
import { knowledgeChunkSourceConfig } from './KnowledgeChunkVectorSource.ts';

export function KnowledgeChunkFullTextSource(): RetrievalStage {
  return createChunkFullTextSource(knowledgeChunkSourceConfig);
}
