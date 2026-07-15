import { read } from '../../../config/neo4j.ts';
import { ChunkRepository } from '../../../repositories/ChunkRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, upsertChunkHits } from './helpers.ts';

export function ChunkFullTextSource(): RetrievalStage {
  return {
    name: 'ChunkFullTextSource',
    async run(ctx, state) {
      if (!ctx.config.chunks.enabled || !ctx.ftQuery) return state;
      const hits = await read((tx) =>
        ChunkRepository.fullTextSearch(tx, { query: ctx.ftQuery, limit: overfetchLimit(ctx) }),
      );
      upsertChunkHits(state, hits, 'chunk_fulltext');
      return state;
    },
  };
}
