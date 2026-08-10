import type { RetrievalStage } from '../types.ts';
import { createChunkFullTextSource } from './chunk-source-factory.ts';
import { researchChunkSourceConfig } from './ResearchChunkVectorSource.ts';

export function ResearchChunkFullTextSource(): RetrievalStage {
  return createChunkFullTextSource(researchChunkSourceConfig);
}
