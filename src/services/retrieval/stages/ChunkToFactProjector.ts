// Bridges chunk hits back into the fact space. For each surviving chunk we
// follow :DERIVED_FROM to pull in facts extracted from that chunk during
// the dream pipeline — so a query term that only appears in a raw passage
// still surfaces the fact via the chunk→fact edge.
//
// Facts pulled this way are tagged source='chunk_derived' with a rank equal to
// the best (lowest) rank among the chunks they were derived from.

import { read } from '../../../config/neo4j.ts';
import { FactRepository } from '../../../repositories/FactRepository.ts';
import type { FactCandidate, RetrievalStage } from '../types.ts';

export function ChunkToFactProjector(): RetrievalStage {
  return {
    name: 'ChunkToFactProjector',
    async run(ctx, state) {
      if (!ctx.config.chunks.enabled || state.chunks.size === 0) return state;

      // Best rank any chunk achieved across its sources.
      const chunkBestRank = new Map<string, number>();
      for (const c of state.chunks.values()) {
        chunkBestRank.set(c.chunk.id, Math.min(...c.sources.map((s) => s.rank)));
      }

      const derivedFacts = await read((tx) =>
        FactRepository.fromChunks(tx, {
          chunkIds: Array.from(chunkBestRank.keys()),
          includeSuperseded: ctx.query.includeSuperseded ?? false,
        }),
      );

      for (const fact of derivedFacts) {
        const factBestChunkRank = Math.min(
          ...fact.sourceChunkIds.map((id) => chunkBestRank.get(id) ?? Number.POSITIVE_INFINITY),
        );
        const entry: FactCandidate = state.facts.get(fact.id) ?? {
          fact,
          sources: [],
          expansionReason: 'chunk_derived',
          hasDirectHit: false,
        };
        entry.sources.push({ source: 'chunk_derived', rank: factBestChunkRank });
        state.facts.set(fact.id, entry);
      }
      return state;
    },
  };
}
