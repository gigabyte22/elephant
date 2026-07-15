import type { ManagedTransaction } from 'neo4j-driver';
import type { Research } from '../models/types.ts';
import { dateParam, nullableDateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import {
  type RetrievalScope,
  memoryItemParams,
  memoryItemSetClause,
  readScope,
  scopeAndClause,
  scopeWhereClause,
} from './scope.ts';

function toResearch(node: Record<string, unknown>): Research {
  return {
    id: node.id as string,
    title: node.title as string,
    source: node.source as string,
    sourceUri: (node.sourceUri as string | undefined) ?? undefined,
    contentHash: (node.contentHash as string | undefined) ?? undefined,
    summary: node.summary as string,
    embedding: (node.embedding as number[]) ?? [],
    tags: (node.tags as string[]) ?? [],
    expiresAt: toJsDateOrNull(node.expiresAt),
    createdAt: toJsDate(node.createdAt),
    updatedAt: toJsDate(node.updatedAt),
    projectId: node.projectId as string,
    ...readScope(node), // overrides projectId with the same value, picks up userId
  };
}

export const ResearchRepository = {
  async create(tx: ManagedTransaction, research: Research): Promise<Research> {
    if (!research.projectId) {
      throw new Error('Research items require projectId');
    }
    const result = await tx.run(
      `MERGE (r:Research {id: $id})
       SET ${memoryItemSetClause('r')},
           r.title = $title,
           r.source = $source,
           r.sourceUri = $sourceUri,
           r.contentHash = $contentHash,
           r.summary = $summary,
           r.embedding = $embedding,
           r.tags = $tags,
           r.expiresAt = CASE WHEN $expiresAt IS NULL THEN NULL ELSE datetime($expiresAt) END,
           r.createdAt = datetime($createdAt),
           r.updatedAt = datetime($updatedAt)
       RETURN r {.*} AS r`,
      {
        id: research.id,
        title: research.title,
        source: research.source,
        sourceUri: research.sourceUri ?? null,
        contentHash: research.contentHash ?? null,
        summary: research.summary,
        embedding: research.embedding,
        tags: research.tags,
        expiresAt: nullableDateParam(research.expiresAt ?? null),
        createdAt: dateParam(research.createdAt),
        updatedAt: dateParam(research.updatedAt),
        ...memoryItemParams('research', research),
      },
    );
    return toResearch(result.records[0]!.get('r'));
  },

  async get(tx: ManagedTransaction, id: string): Promise<Research | null> {
    const result = await tx.run('MATCH (r:Research {id: $id}) RETURN r {.*} AS r', { id });
    const row = result.records[0];
    return row ? toResearch(row.get('r')) : null;
  },

  async list(
    tx: ManagedTransaction,
    input: { scope?: RetrievalScope; limit?: number },
  ): Promise<Research[]> {
    const limit = input.limit ?? 50;
    const { clause, params } = scopeWhereClause('r', input.scope);
    const result = await tx.run(
      `MATCH (r:Research)
       ${clause}
       RETURN r {.*} AS r
       ORDER BY r.updatedAt DESC
       LIMIT toInteger($limit)`,
      { ...params, limit },
    );
    return result.records.map((rec) => toResearch(rec.get('r')));
  },

  async listSimilar(
    tx: ManagedTransaction,
    input: {
      embedding: number[];
      limit: number;
      minScore?: number;
      scope?: RetrievalScope;
    },
  ): Promise<Array<Research & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const { clause, params } = scopeAndClause('node', input.scope);
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('research_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore ${clause}
       RETURN node {.*} AS r, score
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore, ...params },
    );
    return result.records.map((rec) => ({
      ...toResearch(rec.get('r')),
      score: rec.get('score') as number,
    }));
  },

  async softDelete(tx: ManagedTransaction, id: string, at: Date): Promise<void> {
    await tx.run(
      `MATCH (r:Research {id: $id})
       SET r.expiresAt = datetime($at)`,
      { id, at: dateParam(at) },
    );
  },
};
