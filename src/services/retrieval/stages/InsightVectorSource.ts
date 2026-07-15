import { read } from '../../../config/neo4j.ts';
import { InsightRepository } from '../../../repositories/InsightRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit } from './helpers.ts';

export function InsightVectorSource(): RetrievalStage {
  return {
    name: 'InsightVectorSource',
    async run(ctx, state) {
      if (ctx.query.includeInsights === false) return state;
      const hits = await read((tx) =>
        InsightRepository.listSimilar(tx, {
          embedding: ctx.queryVector,
          limit: overfetchLimit(ctx),
        }),
      );
      for (const insight of hits) {
        if (!state.insights.has(insight.id)) {
          state.insights.set(insight.id, { insight, rawScore: insight.score });
        }
      }
      return state;
    },
  };
}
