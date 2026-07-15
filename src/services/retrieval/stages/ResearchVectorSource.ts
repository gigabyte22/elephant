import { read } from '../../../config/neo4j.ts';
import { ResearchRepository } from '../../../repositories/ResearchRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, upsertResearchHits } from './helpers.ts';
import { buildRetrievalScope } from './scope-helpers.ts';

export function ResearchVectorSource(): RetrievalStage {
  return {
    name: 'ResearchVectorSource',
    async run(ctx, state) {
      if (ctx.query.includeResearch !== true) return state;
      // Research is project-scoped — skip if no project supplied to avoid
      // returning cross-project artifacts by accident.
      if (!ctx.query.projectId) return state;
      const hits = await read((tx) =>
        ResearchRepository.listSimilar(tx, {
          embedding: ctx.queryVector,
          limit: overfetchLimit(ctx),
          scope: buildRetrievalScope(ctx.query),
        }),
      );
      upsertResearchHits(state, hits);
      return state;
    },
  };
}
