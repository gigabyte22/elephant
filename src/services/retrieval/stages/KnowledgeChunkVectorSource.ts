import { read } from '../../../config/neo4j.ts';
import { KnowledgeChunkRepository } from '../../../repositories/KnowledgeChunkRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, upsertKnowledgeChunkHits } from './helpers.ts';
import { buildRetrievalScope } from './scope-helpers.ts';

export function KnowledgeChunkVectorSource(): RetrievalStage {
  return {
    name: 'KnowledgeChunkVectorSource',
    async run(ctx, state) {
      if (ctx.query.includeKnowledge !== true) return state;
      const hits = await read((tx) =>
        KnowledgeChunkRepository.listSimilar(tx, {
          embedding: ctx.queryVector,
          limit: overfetchLimit(ctx),
          scope: buildRetrievalScope(ctx.query),
        }),
      );
      upsertKnowledgeChunkHits(state, hits, 'knowledge_chunk_vector');
      return state;
    },
  };
}
