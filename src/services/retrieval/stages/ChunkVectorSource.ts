// Vector search over chunk_vectors. Chunks are SPEC.md §6's first-class
// retrieval units — they surface long-transcript content that hasn't yet
// been distilled into a Fact by the dream pipeline. Gated on
// config.chunks.enabled so deployments without chunked ingest can skip it.

import { read } from '../../../config/neo4j.ts';
import { ChunkRepository } from '../../../repositories/ChunkRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, upsertChunkHits } from './helpers.ts';

export function ChunkVectorSource(): RetrievalStage {
  return {
    name: 'ChunkVectorSource',
    async run(ctx, state) {
      if (!ctx.config.chunks.enabled) return state;
      const hits = await read((tx) =>
        ChunkRepository.listSimilar(tx, { embedding: ctx.queryVector, limit: overfetchLimit(ctx) }),
      );
      upsertChunkHits(state, hits, 'chunk_vector');
      return state;
    },
  };
}
