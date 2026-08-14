// Vector search over the insight_vectors index. Scope pushdown + escalating K
// for the same reason as the fact and preference sources — see
// vector-search.ts: the index returns a GLOBAL top-K that another scope's
// insights can fill before the post-filter ever runs.

import { read } from '../../../config/neo4j.ts';
import { InsightRepository } from '../../../repositories/InsightRepository.ts';
import { annWithEscalation } from '../../../repositories/vector-search.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, recordSourceDiagnostics } from './helpers.ts';
import { buildRetrievalScope, PROJECT_USER_AXES } from './scope-helpers.ts';

export function InsightVectorSource(): RetrievalStage {
  return {
    name: 'InsightVectorSource',
    async run(ctx, state) {
      if (ctx.query.includeInsights === false) return state;
      const scope = buildRetrievalScope(ctx.query, PROJECT_USER_AXES);
      const outcome = await annWithEscalation({
        want: ctx.limit,
        startK: overfetchLimit(ctx),
        config: ctx.config.ann,
        run: (k) =>
          read((tx) =>
            InsightRepository.listSimilar(tx, {
              embedding: ctx.queryVector,
              limit: k,
              scope,
            }),
          ),
      });
      recordSourceDiagnostics(ctx, 'InsightVectorSource', outcome, 'ann');
      for (const insight of outcome.hits) {
        if (!state.insights.has(insight.id)) {
          state.insights.set(insight.id, { insight, rawScore: insight.score });
        }
      }
      return state;
    },
  };
}
