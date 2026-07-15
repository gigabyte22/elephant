import { read } from '../../../config/neo4j.ts';
import { ProcedureRepository } from '../../../repositories/ProcedureRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, upsertProcedureHits } from './helpers.ts';
import { buildRetrievalScope } from './scope-helpers.ts';

export function ProcedureFullTextSource(): RetrievalStage {
  return {
    name: 'ProcedureFullTextSource',
    async run(ctx, state) {
      if (ctx.query.includeProcedures !== true) return state;
      if (!ctx.ftQuery) return state;
      const hits = await read((tx) =>
        ProcedureRepository.fullTextSearch(tx, {
          query: ctx.ftQuery,
          limit: overfetchLimit(ctx),
          scope: buildRetrievalScope(ctx.query),
        }),
      );
      upsertProcedureHits(state, hits, 'procedure_fulltext');
      return state;
    },
  };
}
