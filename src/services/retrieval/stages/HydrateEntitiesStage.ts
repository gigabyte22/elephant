// Batched entity hydration. Collects the union of entityIds across surviving
// facts and issues one UNWIND lookup.

import { read } from '../../../config/neo4j.ts';
import { EntityRepository } from '../../../repositories/EntityRepository.ts';
import type { RetrievalStage } from '../types.ts';

export function HydrateEntitiesStage(): RetrievalStage {
  return {
    name: 'HydrateEntities',
    async run(_ctx, state) {
      const ids = Array.from(
        new Set(Array.from(state.facts.values()).flatMap((c) => c.fact.entityIds)),
      );
      if (ids.length === 0) return state;

      const entities = await read((tx) => EntityRepository.getMany(tx, ids));
      for (const e of entities) state.entities.set(e.id, e);
      return state;
    },
  };
}
