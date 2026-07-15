import { read } from '../../../config/neo4j.ts';
import { PreferenceRepository } from '../../../repositories/PreferenceRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit } from './helpers.ts';

export function PreferenceVectorSource(): RetrievalStage {
  return {
    name: 'PreferenceVectorSource',
    async run(ctx, state) {
      if (ctx.query.includePreferences === false) return state;
      const hits = await read((tx) =>
        PreferenceRepository.listSimilar(tx, {
          embedding: ctx.queryVector,
          limit: overfetchLimit(ctx),
          includeSuperseded: ctx.query.includeSuperseded ?? false,
        }),
      );
      // Stable identity keyed by preference.id; repo filters to validTo IS NULL
      // by default so we see the freshest version first.
      for (const preference of hits) {
        if (!state.preferences.has(preference.id)) {
          state.preferences.set(preference.id, { preference, rawScore: preference.score });
        }
      }
      return state;
    },
  };
}
