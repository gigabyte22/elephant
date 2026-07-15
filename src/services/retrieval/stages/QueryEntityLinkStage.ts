// Links the query to :Entity nodes by vector similarity, recording the matches
// on the context as PageRank seeds. Only runs when PPR is enabled (per-query
// `ppr` override or the env default), so the default recall path pays nothing.

import { read } from '../../../config/neo4j.ts';
import { EntityRepository } from '../../../repositories/EntityRepository.ts';
import type { RetrievalStage } from '../types.ts';

export function QueryEntityLinkStage(): RetrievalStage {
  return {
    name: 'QueryEntityLink',
    async run(ctx, state) {
      const enabled = ctx.query.ppr ?? ctx.config.ppr.enabled;
      if (!enabled || ctx.queryVector.length === 0) return state;
      try {
        ctx.queryEntityIds = await read((tx) =>
          EntityRepository.linkQueryEntities(tx, {
            embedding: ctx.queryVector,
            limit: ctx.config.ppr.queryEntityLinks,
          }),
        );
      } catch (err) {
        // Best-effort: if entity linking fails (e.g. entity_vectors missing),
        // PPR just falls back to seeding from the retrieved facts' entities.
        console.warn('[ppr] query entity linking failed:', (err as Error).message);
      }
      return state;
    },
  };
}
