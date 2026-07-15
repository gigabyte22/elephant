import { read } from '../../../config/neo4j.ts';
import { ProcedureRepository } from '../../../repositories/ProcedureRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, upsertProcedureHits } from './helpers.ts';
import { buildRetrievalScope } from './scope-helpers.ts';

export function ProcedureVectorSource(): RetrievalStage {
  return {
    name: 'ProcedureVectorSource',
    async run(ctx, state) {
      if (ctx.query.includeProcedures !== true) return state;
      const hits = await read((tx) =>
        ProcedureRepository.listSimilar(tx, {
          embedding: ctx.queryVector,
          limit: overfetchLimit(ctx),
          scope: buildRetrievalScope(ctx.query),
        }),
      );
      upsertProcedureHits(state, hits, 'procedure_vector');
      return state;
    },
  };
}
