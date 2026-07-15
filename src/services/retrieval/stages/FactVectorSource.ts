// Vector search over the fact_vectors index. Over-fetches `limit * overfetch`
// to preserve post-filter headroom.

import { read } from '../../../config/neo4j.ts';
import { FactRepository } from '../../../repositories/FactRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, upsertFactHits } from './helpers.ts';

export function FactVectorSource(): RetrievalStage {
  return {
    name: 'FactVectorSource',
    async run(ctx, state) {
      const hits = await read((tx) =>
        FactRepository.listSimilar(tx, {
          embedding: ctx.queryVector,
          limit: overfetchLimit(ctx),
          includeSuperseded: ctx.query.includeSuperseded ?? false,
        }),
      );
      upsertFactHits(state, hits, 'fact_vector');
      return state;
    },
  };
}
