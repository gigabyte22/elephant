import type { RetrievalStage } from '../types.ts';
import { researchChunkSourceConfig } from './ResearchChunkVectorSource.ts';
import { createChunkFullTextSource } from './chunk-source-factory.ts';

export function ResearchChunkFullTextSource(): RetrievalStage {
  return createChunkFullTextSource(researchChunkSourceConfig);
}
