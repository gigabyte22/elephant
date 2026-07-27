// Vector search over the fact_vectors index.
//
// Two things the naive version got wrong. It never pushed the caller's scope
// down at all — every other category does — so a scoped query paid for a
// global top-K and then discarded most of it in the post-filter. And a fixed
// overfetch cannot know how selective that filter is: `queryNodes` returns the
// GLOBAL top-K, so survivors ≈ K·s, and recall starves silently once K·s falls
// below `limit`. Escalating K until enough rows survive fixes both, and only
// costs extra queries when the filter actually bites.

import { read } from '../../../config/neo4j.ts';
import { FactRepository } from '../../../repositories/FactRepository.ts';
import { annWithEscalation } from '../../../repositories/vector-search.ts';
import type { RetrievalStage } from '../types.ts';
import {
  asOfOverfetchLimit,
  recallAsOf,
  recordSourceDiagnostics,
  upsertFactHits,
} from './helpers.ts';
import { buildRetrievalScope } from './scope-helpers.ts';

export function FactVectorSource(): RetrievalStage {
  return {
    name: 'FactVectorSource',
    async run(ctx, state) {
      const asOf = recallAsOf(ctx);
      const scope = buildRetrievalScope(ctx.query);
      const outcome = await annWithEscalation({
        want: ctx.limit,
        startK: asOfOverfetchLimit(ctx, asOf),
        config: ctx.config.ann,
        run: (k) =>
          read((tx) =>
            FactRepository.listSimilar(tx, {
              embedding: ctx.queryVector,
              limit: k,
              includeSuperseded: ctx.query.includeSuperseded ?? false,
              asOf,
              scope,
            }),
          ),
      });
      recordSourceDiagnostics(ctx, 'FactVectorSource', outcome, 'ann');
      upsertFactHits(state, outcome.hits, 'fact_vector');
      return state;
    },
  };
}
