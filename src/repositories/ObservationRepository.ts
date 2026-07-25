import type { ManagedTransaction } from 'neo4j-driver';
import type { Observation } from '../models/types.ts';
import { dateParam, toJsDate } from '../utils/neo4j-conv.ts';
import { memoryItemParams, memoryItemSetClause, readScope } from './scope.ts';

function toObservation(node: Record<string, unknown>): Observation {
  return {
    id: node.id as string,
    agentId: node.agentId as string,
    sessionId: node.sessionId as string,
    content: node.content as string,
    recordedAt: toJsDate(node.recordedAt),
    expiresAt: toJsDate(node.expiresAt),
    embedding: (node.embedding as number[]) ?? [],
    ...readScope(node),
  };
}

export const ObservationRepository = {
  async create(tx: ManagedTransaction, obs: Observation): Promise<Observation> {
    const result = await tx.run(
      `MERGE (o:Observation {id: $id})
       SET ${memoryItemSetClause('o')},
           o.agentId = $agentId,
           o.sessionId = $sessionId,
           o.content = $content,
           o.recordedAt = datetime($recordedAt),
           o.expiresAt = datetime($expiresAt),
           o.embedding = $embedding
       RETURN o {.*} AS o`,
      {
        id: obs.id,
        agentId: obs.agentId,
        sessionId: obs.sessionId,
        content: obs.content,
        recordedAt: dateParam(obs.recordedAt),
        expiresAt: dateParam(obs.expiresAt),
        embedding: obs.embedding,
        ...memoryItemParams('observation', obs),
      },
    );
    return toObservation(result.records[0]!.get('o'));
  },

  async listForSession(
    tx: ManagedTransaction,
    sessionId: string,
    limit = 100,
  ): Promise<Observation[]> {
    const result = await tx.run(
      `MATCH (o:Observation {sessionId: $sessionId})
       WHERE o.expiresAt > datetime()
       RETURN o {.*} AS o
       ORDER BY o.recordedAt DESC
       LIMIT toInteger($limit)`,
      { sessionId, limit },
    );
    return result.records.map((r) => toObservation(r.get('o')));
  },

  // Hybrid recall: cosine over observation_vectors, hard-scoped to one session
  // and only unexpired rows. Session id is required so boost-mode never leaks
  // another session's working memory.
  async listSimilar(
    tx: ManagedTransaction,
    input: {
      embedding: number[];
      sessionId: string;
      limit: number;
      minScore?: number;
      now?: Date;
    },
  ): Promise<Array<Observation & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const now = input.now ?? new Date();
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('observation_vectors', toInteger($limit), $vec)
       YIELD node, score
       WHERE score >= $minScore
         AND node.sessionId = $sessionId
         AND node.expiresAt > datetime($now)
       RETURN node {.*} AS o, score
       ORDER BY score DESC`,
      {
        vec: input.embedding,
        limit: input.limit,
        minScore,
        sessionId: input.sessionId,
        now: dateParam(now),
      },
    );
    return result.records.map((r) => ({
      ...toObservation(r.get('o')),
      score: r.get('score') as number,
    }));
  },

  async reapExpired(tx: ManagedTransaction, now: Date): Promise<number> {
    const result = await tx.run(
      `MATCH (o:Observation)
       WHERE o.expiresAt <= datetime($now)
       WITH o LIMIT 5000
       DETACH DELETE o
       RETURN count(*) AS deleted`,
      { now: dateParam(now) },
    );
    return (result.records[0]?.get('deleted') as number) ?? 0;
  },
};
