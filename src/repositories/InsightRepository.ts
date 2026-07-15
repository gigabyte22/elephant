import type { ManagedTransaction } from 'neo4j-driver';
import type { Insight } from '../models/types.ts';
import { dateParam, toJsDate } from '../utils/neo4j-conv.ts';
import { memoryItemParams, memoryItemSetClause, readScope } from './scope.ts';

function toInsight(node: Record<string, unknown>): Insight {
  return {
    id: node.id as string,
    content: node.content as string,
    embedding: (node.embedding as number[]) ?? [],
    promotedFromFactIds: (node.promotedFromFactIds as string[]) ?? [],
    createdAt: toJsDate(node.createdAt),
    ...readScope(node),
  };
}

export const InsightRepository = {
  async create(tx: ManagedTransaction, insight: Insight): Promise<Insight> {
    const result = await tx.run(
      `MERGE (i:Insight {id: $id})
       SET ${memoryItemSetClause('i')},
           i.content = $content,
           i.embedding = $embedding,
           i.promotedFromFactIds = $promotedFromFactIds,
           i.createdAt = datetime($createdAt)
       RETURN i {.*} AS i`,
      {
        id: insight.id,
        content: insight.content,
        embedding: insight.embedding,
        promotedFromFactIds: insight.promotedFromFactIds,
        createdAt: dateParam(insight.createdAt),
        ...memoryItemParams('insight', insight),
      },
    );
    if (insight.promotedFromFactIds.length > 0) {
      await tx.run(
        `MATCH (i:Insight {id: $insightId})
         UNWIND $factIds AS fid
         MATCH (f:Fact {id: fid})
         MERGE (i)-[:DERIVED_FROM]->(f)`,
        { insightId: insight.id, factIds: insight.promotedFromFactIds },
      );
    }
    return toInsight(result.records[0]!.get('i'));
  },

  async list(tx: ManagedTransaction, limit = 100): Promise<Insight[]> {
    const result = await tx.run(
      `MATCH (i:Insight)
       RETURN i {.*} AS i
       ORDER BY i.createdAt DESC
       LIMIT toInteger($limit)`,
      { limit },
    );
    return result.records.map((r) => toInsight(r.get('i')));
  },

  async listSimilar(
    tx: ManagedTransaction,
    input: { embedding: number[]; limit: number; minScore?: number },
  ): Promise<Array<Insight & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('insight_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore
       RETURN node {.*} AS i, score
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore },
    );
    return result.records.map((r) => ({
      ...toInsight(r.get('i')),
      score: r.get('score') as number,
    }));
  },
};
