// First stage: embed the query and prepare the full-text query string.
// Factored out so tests can pre-seed `queryVector` on the context and skip
// the embedder round-trip.

import type { EmbeddingAdapter } from '../../../adapters/embeddings/types.ts';
import { expandQueryForFullText } from '../query/escape.ts';
import type { RetrievalStage } from '../types.ts';

export function QueryPreparerStage(embedder: EmbeddingAdapter): RetrievalStage {
  return {
    name: 'QueryPreparer',
    async run(ctx, state) {
      ctx.queryVector = ctx.queryVector.length
        ? ctx.queryVector
        : await embedder.embed(ctx.query.q);
      ctx.ftQuery = expandQueryForFullText(ctx.query.q);
      return state;
    },
  };
}
