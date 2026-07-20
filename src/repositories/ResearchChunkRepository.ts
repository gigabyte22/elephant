import type { ManagedTransaction } from 'neo4j-driver';
import type { ResearchChunk } from '../models/types.ts';
import { toJsDate } from '../utils/neo4j-conv.ts';
import { createChunkRepository } from './chunk-repository-factory.ts';
import { type RetrievalScope, readScope } from './scope.ts';

function toResearchChunk(node: Record<string, unknown>): ResearchChunk {
  return {
    id: node.id as string,
    researchId: node.researchId as string,
    position: node.position as number,
    text: node.text as string,
    tokenCount: node.tokenCount as number,
    embedding: (node.embedding as number[]) ?? [],
    createdAt: toJsDate(node.createdAt),
    ...readScope(node),
  };
}

// Research is the expirable tier, so every search joins the parent and drops
// chunks whose research has lapsed or been soft-deleted (softDelete = set
// expiresAt = now) — otherwise deleted research resurfaces through its chunks.
const core = createChunkRepository<ResearchChunk>({
  label: 'ResearchChunk',
  kind: 'research_chunk',
  parentLabel: 'Research',
  parentEdge: 'FROM_RESEARCH',
  parentIdProp: 'researchId',
  vectorIndex: 'researchchunk_vectors',
  fulltextIndex: 'research_chunk_fulltext',
  mapNode: toResearchChunk,
  parentLivenessGuard: true,
});

export const ResearchChunkRepository = {
  async createForResearch(
    tx: ManagedTransaction,
    input: { researchId: string; chunks: ResearchChunk[] },
  ): Promise<void> {
    return core.createForParent(tx, { parentId: input.researchId, chunks: input.chunks });
  },

  async listByResearch(tx: ManagedTransaction, researchId: string): Promise<ResearchChunk[]> {
    return core.listByParent(tx, researchId);
  },

  async listSimilar(
    tx: ManagedTransaction,
    input: { embedding: number[]; limit: number; minScore?: number; scope?: RetrievalScope },
  ): Promise<Array<ResearchChunk & { score: number }>> {
    return core.listSimilar(tx, input);
  },

  async fullTextSearch(
    tx: ManagedTransaction,
    input: { query: string; limit: number; scope?: RetrievalScope },
  ): Promise<Array<ResearchChunk & { score: number }>> {
    return core.fullTextSearch(tx, input);
  },

  async deleteForResearch(tx: ManagedTransaction, researchId: string): Promise<number> {
    return core.deleteForParent(tx, researchId);
  },
};
