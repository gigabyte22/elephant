// Vector search over the preference_vectors index.
//
// Scope is pushed into the query and K escalates until enough rows survive it,
// for the reason spelled out in vector-search.ts: `queryNodes` returns the
// GLOBAL top-K and scope is a post-filter, so other users' semantically
// similar preferences could fill K and starve the caller's own.

import { read } from '../../../config/neo4j.ts';
import { PreferenceRepository } from '../../../repositories/PreferenceRepository.ts';
import { annWithEscalation } from '../../../repositories/vector-search.ts';
import type { RetrievalStage } from '../types.ts';
import { asOfOverfetchLimit, recallAsOf, recordSourceDiagnostics } from './helpers.ts';
import { buildRetrievalScope, PROJECT_USER_AXES } from './scope-helpers.ts';

export function PreferenceVectorSource(): RetrievalStage {
  return {
    name: 'PreferenceVectorSource',
    async run(ctx, state) {
      if (ctx.query.includePreferences === false) return state;
      const asOf = recallAsOf(ctx);
      const scope = buildRetrievalScope(ctx.query, PROJECT_USER_AXES);
      const outcome = await annWithEscalation({
        want: ctx.limit,
        startK: asOfOverfetchLimit(ctx, asOf),
        config: ctx.config.ann,
        run: (k) =>
          read((tx) =>
            PreferenceRepository.listSimilar(tx, {
              embedding: ctx.queryVector,
              limit: k,
              includeSuperseded: ctx.query.includeSuperseded ?? false,
              asOf,
              scope,
            }),
          ),
      });
      recordSourceDiagnostics(ctx, 'PreferenceVectorSource', outcome, 'ann');
      // Stable identity keyed by preference.id; the repo's valid-time filter
      // leaves exactly one version per key, so first-write-wins is safe.
      for (const preference of outcome.hits) {
        if (!state.preferences.has(preference.id)) {
          state.preferences.set(preference.id, { preference, rawScore: preference.score });
        }
      }
      return state;
    },
  };
}
