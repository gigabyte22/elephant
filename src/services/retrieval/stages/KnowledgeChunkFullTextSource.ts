import { read } from '../../../config/neo4j.ts';
import { KnowledgeChunkRepository } from '../../../repositories/KnowledgeChunkRepository.ts';
import type { RetrievalStage } from '../types.ts';
import { overfetchLimit, upsertKnowledgeChunkHits } from './helpers.ts';
import { buildRetrievalScope } from './scope-helpers.ts';

export function KnowledgeChunkFullTextSource(): RetrievalStage {
  return {
    name: 'KnowledgeChunkFullTextSource',
    async run(ctx, state) {
      if (ctx.query.includeKnowledge !== true) return state;
      if (!ctx.ftQuery) return state;
      const hits = await read((tx) =>
        KnowledgeChunkRepository.fullTextSearch(tx, {
          query: ctx.ftQuery,
          limit: overfetchLimit(ctx),
          scope: buildRetrievalScope(ctx.query),
        }),
      );
      upsertKnowledgeChunkHits(state, hits, 'knowledge_chunk_fulltext');
      return state;
    },
  };
}
