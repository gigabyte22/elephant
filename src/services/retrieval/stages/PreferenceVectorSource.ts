import { read } from '../../../config/neo4j.ts';
import { PreferenceRepository } from '../../../repositories/PreferenceRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { asOfOverfetchLimit, recallAsOf } from './helpers.ts';

export function PreferenceVectorSource(): RetrievalStage {
  return {
    name: 'PreferenceVectorSource',
    async run(ctx, state) {
      if (ctx.query.includePreferences === false) return state;
      const asOf = recallAsOf(ctx);
      const hits = await read((tx) =>
        PreferenceRepository.listSimilar(tx, {
          embedding: ctx.queryVector,
          limit: asOfOverfetchLimit(ctx, asOf),
          includeSuperseded: ctx.query.includeSuperseded ?? false,
          asOf,
        }),
      );
      // Stable identity keyed by preference.id; the repo's valid-time filter
      // leaves exactly one version per key, so first-write-wins is safe.
      for (const preference of hits) {
        if (!state.preferences.has(preference.id)) {
          state.preferences.set(preference.id, { preference, rawScore: preference.score });
        }
      }
      return state;
    },
  };
}
