import type { ManagedTransaction } from 'neo4j-driver';
import type { Insight } from '../models/types.ts';
import { dateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import {
  memoryItemParams,
  memoryItemSetClause,
  type RetrievalScope,
  readScope,
  scopeAndClause,
} from './scope.ts';

function toInsight(node: Record<string, unknown>): Insight {
  return {
    id: node.id as string,
    content: node.content as string,
    embedding: (node.embedding as number[]) ?? [],
    promotedFromFactIds: (node.promotedFromFactIds as string[]) ?? [],
    createdAt: toJsDate(node.createdAt),
    validTo: toJsDateOrNull(node.validTo),
    retiredReason: (node.retiredReason as string | undefined) ?? undefined,
    ...readScope(node),
  };
}

// Null-safe equality for one axis of a dedup bucket: a NULL property matches
// only a NULL parameter. One line per axis so it splices into the Cypher at the
// template's own indent, the way every other clause fragment here does.
function bucketAxisMatch(axis: 'projectId' | 'userId'): string {
  const param = `$bucket_${axis}`;
  return `(node.${axis} = ${param} OR (node.${axis} IS NULL AND ${param} IS NULL))`;
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

  /**
   * Retire every insight whose sources are ALL now dead, scoped to the given
   * fact ids so cost is O(dead facts) rather than O(insights).
   *
   * "All sources dead", not "any source dead": once dedup starts attaching
   * corroborating facts to one insight, a single retraction should not retire
   * a claim two other facts still support.
   */
  async retireForDeadFacts(
    tx: ManagedTransaction,
    input: { factIds: string[]; at: Date; reason: string },
  ): Promise<string[]> {
    if (input.factIds.length === 0) return [];
    const result = await tx.run(
      `UNWIND $factIds AS fid
       MATCH (i:Insight)-[:DERIVED_FROM]->(:Fact {id: fid})
       WHERE i.validTo IS NULL
         AND NOT EXISTS {
           MATCH (i)-[:DERIVED_FROM]->(alive:Fact)
           WHERE alive.validTo IS NULL AND alive.deletedAt IS NULL
         }
       WITH DISTINCT i
       SET i.validTo = datetime($at), i.retiredReason = $reason
       RETURN collect(i.id) AS ids`,
      { factIds: input.factIds, at: dateParam(input.at), reason: input.reason },
    );
    return (result.records[0]?.get('ids') as string[]) ?? [];
  },

  /**
   * Nightly reconciliation, and the reason this change ships no backfill
   * script: the sweep IS the repair, and it converges.
   *
   * A write-time cascade is the primary mechanism because it keeps the read a
   * cheap scalar rather than a per-candidate join (which would re-create the
   * post-ANN starvation problem). Its weakness is that a missed call site
   * silently reintroduces the bug — so this runs the join once a night and
   * makes that self-healing within 24h.
   *
   * The EXISTS guard is load-bearing: it grandfathers legacy insights created
   * with an empty promotedFromFactIds (no edge was ever written), which would
   * otherwise be retired on the first sweep because "no live source" is
   * vacuously true for them.
   */
  async retireOrphaned(
    tx: ManagedTransaction,
    input: { at: Date; limit: number },
  ): Promise<number> {
    const result = await tx.run(
      `MATCH (i:Insight)
       WHERE i.validTo IS NULL
         AND EXISTS { MATCH (i)-[:DERIVED_FROM]->(:Fact) }
         AND NOT EXISTS {
           MATCH (i)-[:DERIVED_FROM]->(f:Fact)
           WHERE f.validTo IS NULL AND f.deletedAt IS NULL
         }
       WITH i LIMIT toInteger($limit)
       SET i.validTo = datetime($at), i.retiredReason = 'source_dead'
       RETURN count(i) AS n`,
      { at: dateParam(input.at), limit: input.limit },
    );
    return (result.records[0]?.get('n') as number) ?? 0;
  },

  /** Idempotency gate for promotion — cheap id lookup, no vector call. */
  async findBySourceFact(tx: ManagedTransaction, factId: string): Promise<Insight | null> {
    const result = await tx.run(
      `MATCH (i:Insight)-[:DERIVED_FROM]->(:Fact {id: $factId})
       WHERE i.validTo IS NULL
       RETURN i {.*} AS i
       LIMIT 1`,
      { factId },
    );
    const rec = result.records[0];
    return rec ? toInsight(rec.get('i')) : null;
  },

  /**
   * Attach a corroborating fact instead of cloning the insight. Keeps the
   * array and the edge set consistent — they are two views of one relation —
   * and means the insight now outlives the death of any single source.
   */
  async addSource(
    tx: ManagedTransaction,
    input: { insightId: string; factId: string },
  ): Promise<void> {
    await tx.run(
      `MATCH (i:Insight {id: $insightId}), (f:Fact {id: $factId})
       MERGE (i)-[:DERIVED_FROM]->(f)
       SET i.promotedFromFactIds =
         CASE WHEN $factId IN coalesce(i.promotedFromFactIds, [])
              THEN i.promotedFromFactIds
              ELSE coalesce(i.promotedFromFactIds, []) + $factId END`,
      { insightId: input.insightId, factId: input.factId },
    );
  },

  async list(
    tx: ManagedTransaction,
    limit = 100,
    opts: { includeRetired?: boolean } = {},
  ): Promise<Insight[]> {
    const result = await tx.run(
      `MATCH (i:Insight)
       WHERE $includeRetired OR i.validTo IS NULL
       RETURN i {.*} AS i
       ORDER BY i.createdAt DESC
       LIMIT toInteger($limit)`,
      { limit, includeRetired: opts.includeRetired ?? false },
    );
    return result.records.map((r) => toInsight(r.get('i')));
  },

  /**
   * Nearest insights to an embedding.
   *
   * Both scope params filter inside the query rather than over the results,
   * because `queryNodes` returns the GLOBAL top-K: rows the caller could never
   * accept fill those slots, and a caller-side filter is then left sifting a
   * neighbourhood that holds nothing for it. Callers still have to overfetch
   * `limit` to pay for what the index cannot pre-filter.
   */
  async listSimilar(
    tx: ManagedTransaction,
    input: {
      embedding: number[];
      limit: number;
      minScore?: number;
      includeRetired?: boolean;
      // Four-axis retrieval scope, same shape every other repository calls
      // `scope`.
      scope?: RetrievalScope;
      // One exact scope bucket, and deliberately none of the other three
      // shapes: not `scope`'s filter mode (where a NULL prop matches anything)
      // or strict mode (where it matches nothing and the unscoped bucket is
      // therefore inexpressible), and not FactRepository's `dedupScope`, whose
      // user axis is permissive. Here both axes match null-safely, so NULL
      // means "the unscoped bucket" rather than "shared, matches anything".
      //
      // That is the dream's promotion-dedup rule: an insight is a verbatim
      // copy of a fact, so it dedups against the exact tuple its source fact
      // occupies — the same partition consolidation clusters by.
      bucket?: { projectId: string | null; userId: string | null };
    },
  ): Promise<Array<Insight & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const retrieval = scopeAndClause('node', input.scope);
    const bucketClause = input.bucket
      ? `AND ${bucketAxisMatch('projectId')} AND ${bucketAxisMatch('userId')}`
      : '';
    const result = await tx.run(
      // Retired insights are excluded by default. Without this an insight
      // promoted from a fact that was later contradicted kept asserting the
      // stale claim in every recall, forever — the promotion channel silently
      // defeated the supersede machinery.
      `CALL db.index.vector.queryNodes('insight_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore
         AND ($includeRetired OR node.validTo IS NULL)
       ${retrieval.clause}
       ${bucketClause}
       RETURN node {.*} AS i, score
       ORDER BY score DESC`,
      {
        vec: input.embedding,
        limit: input.limit,
        minScore,
        includeRetired: input.includeRetired ?? false,
        bucket_projectId: input.bucket?.projectId ?? null,
        bucket_userId: input.bucket?.userId ?? null,
        ...retrieval.params,
      },
    );
    return result.records.map((r) => ({
      ...toInsight(r.get('i')),
      score: r.get('score') as number,
    }));
  },
};
