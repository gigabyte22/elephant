// Parameterized vector/fulltext source-stage pair shared by the chunk-shaped
// categories (KnowledgeChunk, ResearchChunk). Each instantiation differs only
// in gate, repository, candidate map, and source tags — the stage body is the
// same repo call + upsert bookkeeping.

import type { ManagedTransaction } from 'neo4j-driver';
import { read } from '../../../config/neo4j.ts';
import type { RetrievalScope } from '../../../repositories/scope.ts';
import type { CandidateSource, PipelineState, RetrievalContext, RetrievalStage } from '../types.ts';
import { overfetchLimit } from './helpers.ts';
import { buildRetrievalScope } from './scope-helpers.ts';

export interface ChunkSourceConfig<T> {
  vectorStageName: string;
  fulltextStageName: string;
  vectorSource: CandidateSource;
  fulltextSource: CandidateSource;
  gate(ctx: RetrievalContext): boolean;
  repo: {
    listSimilar(
      tx: ManagedTransaction,
      input: { embedding: number[]; limit: number; scope?: RetrievalScope },
    ): Promise<Array<T & { score: number }>>;
    fullTextSearch(
      tx: ManagedTransaction,
      input: { query: string; limit: number; scope?: RetrievalScope },
    ): Promise<Array<T & { score: number }>>;
  };
  upsert(
    state: PipelineState,
    hits: ReadonlyArray<T & { score: number }>,
    source: CandidateSource,
  ): void;
}

export function createChunkVectorSource<T>(cfg: ChunkSourceConfig<T>): RetrievalStage {
  return {
    name: cfg.vectorStageName,
    async run(ctx, state) {
      if (!cfg.gate(ctx)) return state;
      const hits = await read((tx) =>
        cfg.repo.listSimilar(tx, {
          embedding: ctx.queryVector,
          limit: overfetchLimit(ctx),
          scope: buildRetrievalScope(ctx.query),
        }),
      );
      cfg.upsert(state, hits, cfg.vectorSource);
      return state;
    },
  };
}

export function createChunkFullTextSource<T>(cfg: ChunkSourceConfig<T>): RetrievalStage {
  return {
    name: cfg.fulltextStageName,
    async run(ctx, state) {
      if (!cfg.gate(ctx)) return state;
      if (!ctx.ftQuery) return state;
      const hits = await read((tx) =>
        cfg.repo.fullTextSearch(tx, {
          query: ctx.ftQuery,
          limit: overfetchLimit(ctx),
          scope: buildRetrievalScope(ctx.query),
        }),
      );
      cfg.upsert(state, hits, cfg.fulltextSource);
      return state;
    },
  };
}
