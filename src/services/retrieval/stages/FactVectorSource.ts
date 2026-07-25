// Vector search over the fact_vectors index. Over-fetches `limit * overfetch`
// to preserve post-filter headroom, widened again for a historical `asOf`
// because the valid-time predicate runs after the index picks its top-K.

import { read } from '../../../config/neo4j.ts';
import { FactRepository } from '../../../repositories/FactRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { asOfOverfetchLimit, recallAsOf, upsertFactHits } from './helpers.ts';

export function FactVectorSource(): RetrievalStage {
  return {
    name: 'FactVectorSource',
    async run(ctx, state) {
      const asOf = recallAsOf(ctx);
      const hits = await read((tx) =>
        FactRepository.listSimilar(tx, {
          embedding: ctx.queryVector,
          limit: asOfOverfetchLimit(ctx, asOf),
          includeSuperseded: ctx.query.includeSuperseded ?? false,
          asOf,
        }),
      );
      upsertFactHits(state, hits, 'fact_vector');
      return state;
    },
  };
}
