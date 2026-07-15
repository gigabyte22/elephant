// BM25-over-English full-text search on fact_fulltext. Uses ctx.ftQuery
// (escaped/expanded) rather than ctx.query.q so special chars don't break the
// Lucene parser.

import { read } from '../../../config/neo4j.ts';
import { FactRepository } from '../../../repositories/FactRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, upsertFactHits } from './helpers.ts';

export function FactFullTextSource(): RetrievalStage {
  return {
    name: 'FactFullTextSource',
    async run(ctx, state) {
      if (!ctx.ftQuery) return state;
      const hits = await read((tx) =>
        FactRepository.fullTextSearch(tx, {
          query: ctx.ftQuery,
          limit: overfetchLimit(ctx),
          includeSuperseded: ctx.query.includeSuperseded ?? false,
        }),
      );
      upsertFactHits(state, hits, 'fact_fulltext');
      return state;
    },
  };
}
