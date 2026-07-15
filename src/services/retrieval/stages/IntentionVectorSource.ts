import { read } from '../../../config/neo4j.ts';
import { IntentionRepository } from '../../../repositories/IntentionRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, upsertIntentionHits } from './helpers.ts';
import { buildRetrievalScope } from './scope-helpers.ts';

// Surfaces pending intentions ("open commitments") in recall. Gated purely on
// the per-query `includeIntentions` flag (matching knowledge/procedure/research
// sources) so the default recall path pays no extra index cost. listSimilar
// already restricts to status = 'pending'.
export function IntentionVectorSource(): RetrievalStage {
  return {
    name: 'IntentionVectorSource',
    async run(ctx, state) {
      if (ctx.query.includeIntentions !== true) return state;
      const hits = await read((tx) =>
        IntentionRepository.listSimilar(tx, {
          embedding: ctx.queryVector,
          limit: overfetchLimit(ctx),
          scope: buildRetrievalScope(ctx.query),
        }),
      );
      upsertIntentionHits(state, hits);
      return state;
    },
  };
}
