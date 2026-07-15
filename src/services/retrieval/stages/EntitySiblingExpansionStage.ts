// 1-hop entity expansion: for the top-N already-fused facts, pull facts that
// share an entity with any of the seeds. This surfaces related knowledge the
// query didn't match directly but is topically adjacent through the graph.
// Damped in BlendedScoringStage so siblings don't drown direct hits.

import { read } from '../../../config/neo4j.ts';
import { FactRepository } from '../../../repositories/FactRepository.ts';
import type { FactCandidate, RetrievalStage } from '../types.ts';

export function EntitySiblingExpansionStage(): RetrievalStage {
  return {
    name: 'EntitySiblingExpansion',
    async run(ctx, state) {
      if (!ctx.config.siblings.enabled || state.facts.size === 0) return state;

      // Gather entities from the top facts by fusedScore. We cap seeds so we
      // don't expand from the whole overfetch — only the ones actually likely
      // to make the final result set.
      const seeds = Array.from(state.facts.values())
        .filter((c) => typeof c.fusedScore === 'number')
        .sort((a, b) => (b.fusedScore ?? 0) - (a.fusedScore ?? 0))
        .slice(0, ctx.limit);

      const entityIds = Array.from(new Set(seeds.flatMap((s) => s.fact.entityIds).filter(Boolean)));
      if (entityIds.length === 0) return state;

      const excludeFactIds = Array.from(state.facts.keys());
      const siblings = await read((tx) =>
        FactRepository.siblingFactsByEntity(tx, {
          entityIds,
          excludeFactIds,
          limit: ctx.config.siblings.budget,
          includeSuperseded: ctx.query.includeSuperseded ?? false,
        }),
      );

      siblings.forEach((fact, i) => {
        if (state.facts.has(fact.id)) return;
        const entry: FactCandidate = {
          fact,
          sources: [{ source: 'entity_sibling', rank: i }],
          expansionReason: 'entity_sibling',
          hasDirectHit: false,
          // Siblings didn't go through fusion, but we seed fusedScore so the
          // downstream scoring has a comparable signal. Small baseline so the
          // damped blend keeps them below direct hits.
          fusedScore: 1 / (ctx.config.rrfK + i + 1),
        };
        state.facts.set(fact.id, entry);
      });
      return state;
    },
  };
}
