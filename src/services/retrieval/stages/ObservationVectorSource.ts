// Opt-in vector search over unexpired session observations. Hard-requires
// sessionId so boost-mode never surfaces another session's working memory.

import { read } from '../../../config/neo4j.ts';
import { ObservationRepository } from '../../../repositories/ObservationRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit } from './helpers.ts';

export function ObservationVectorSource(): RetrievalStage {
  return {
    name: 'ObservationVectorSource',
    async run(ctx, state) {
      if (!ctx.query.includeObservations) return state;
      const sessionId = ctx.query.sessionId;
      if (!sessionId) return state;

      const hits = await read((tx) =>
        ObservationRepository.listSimilar(tx, {
          embedding: ctx.queryVector,
          sessionId,
          limit: overfetchLimit(ctx),
          now: ctx.now,
        }),
      );
      for (const hit of hits) {
        if (!state.observations.has(hit.id)) {
          state.observations.set(hit.id, { observation: hit, rawScore: hit.score });
        }
      }
      return state;
    },
  };
}
