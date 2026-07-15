// For top chunks (by fusedScore), walk :NEXT ±radius hops to pull adjacent
// passages. Only runs when the query asks for chunks (includeChunks=1) — the
// neighbours are citation context, not primary hits.

import { read } from '../../../config/neo4j.ts';
import { ChunkRepository } from '../../../repositories/ChunkRepository.ts';
import type { ChunkCandidate, RetrievalStage } from '../types.ts';

export function ChunkNeighborExpansionStage(): RetrievalStage {
  return {
    name: 'ChunkNeighborExpansion',
    async run(ctx, state) {
      if (!ctx.query.includeChunks || state.chunks.size === 0) return state;

      const radius = Math.max(
        1,
        Math.min(3, ctx.query.chunkNeighborRadius ?? ctx.config.chunkNeighborRadius),
      );

      const topChunks = Array.from(state.chunks.values())
        .filter((c) => typeof c.fusedScore === 'number')
        .sort((a, b) => (b.fusedScore ?? 0) - (a.fusedScore ?? 0))
        .slice(0, ctx.limit);

      const seedIds = topChunks.map((c) => c.chunk.id);
      if (seedIds.length === 0) return state;

      const neighbours = await read((tx) =>
        ChunkRepository.neighbors(tx, { chunkIds: seedIds, radius }),
      );

      const seedFused = Math.max(...topChunks.map((c) => c.fusedScore ?? 0));
      for (const chunk of neighbours) {
        if (state.chunks.has(chunk.id)) continue;
        const entry: ChunkCandidate = {
          chunk,
          sources: [{ source: 'chunk_neighbor', rank: 0 }],
          expansionReason: 'chunk_neighbor',
          // Neighbours are context — given a modest fraction of the parent
          // fused score so they sort after direct matches.
          fusedScore: seedFused * 0.3,
        };
        state.chunks.set(chunk.id, entry);
      }
      return state;
    },
  };
}
