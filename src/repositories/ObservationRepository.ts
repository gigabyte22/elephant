import type { ManagedTransaction } from 'neo4j-driver';
import type { Observation } from '../models/types.ts';
import { dateParam, toJsDate } from '../utils/neo4j-conv.ts';
import { memoryItemParams, memoryItemSetClause, readScope, scopeAndClause } from './scope.ts';

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

  // `userId` separates one participant's working memory inside a session shared
  // by several humans. It runs in 'filter' mode, so null-user observations are
  // session-shared and still match; an absent userId emits no clause at all.
  async listForSession(
    tx: ManagedTransaction,
    sessionId: string,
    limit = 100,
    userId?: string,
  ): Promise<Observation[]> {
    const { clause, params } = scopeAndClause('o', { userId, userScope: 'filter' });
    const result = await tx.run(
      `MATCH (o:Observation {sessionId: $sessionId})
       WHERE o.expiresAt > datetime()
         ${clause}
       RETURN o {.*} AS o
       ORDER BY o.recordedAt DESC
       LIMIT toInteger($limit)`,
      { sessionId, limit, ...params },
    );
    return result.records.map((r) => toObservation(r.get('o')));
  },

  // Hybrid recall over one session's working memory.
  //
  // Pre-filtered scan + exact cosine, NOT an ANN query. queryNodes returns the
  // GLOBAL top-K and every predicate runs afterwards, so applying sessionId —
  // the most selective axis in the system — as a post-filter meant survivors
  // were roughly K/N for N concurrent sessions. Recall silently collapsed as
  // the deployment grew, and the failure mode was a 200 with an empty array,
  // indistinguishable from "nothing matched".
  //
  // Scanning is affordable here precisely because observations are TTL-bounded
  // working memory reaped by ObservationReaper, so a session's live set is
  // tens-to-hundreds of rows. That invariant is now load-bearing: if the
  // reaper stops, this query degrades. The composite (sessionId, expiresAt)
  // index keeps the MATCH a seek rather than a label scan.
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
      `MATCH (node:Observation {sessionId: $sessionId})
       WHERE node.expiresAt > datetime($now)
         AND node.embedding IS NOT NULL
       WITH node, vector.similarity.cosine(node.embedding, $vec) AS score
       WHERE score >= $minScore
       RETURN node {.*} AS o, score
       ORDER BY score DESC
       LIMIT toInteger($limit)`,
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
