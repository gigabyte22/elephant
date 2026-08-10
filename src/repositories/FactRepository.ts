import type { ManagedTransaction } from 'neo4j-driver';
import type { Fact } from '../models/types.ts';
import { dateParam, nullableDateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import { validAtClause } from '../utils/temporal.ts';
import {
  memoryItemParams,
  memoryItemSetClause,
  type RetrievalScope,
  readScope,
  scopeAndClause,
} from './scope.ts';

function toFact(node: Record<string, unknown>, extras: { entityIds?: string[] } = {}): Fact {
  return {
    id: node.id as string,
    content: node.content as string,
    category: (node.category as string | undefined) ?? undefined,
    confidence: node.confidence as number,
    importance: node.importance as number,
    validFrom: toJsDate(node.validFrom),
    validTo: toJsDateOrNull(node.validTo),
    recordedAt: toJsDate(node.recordedAt),
    deletedAt: toJsDateOrNull(node.deletedAt),
    prunedAt: toJsDateOrNull(node.prunedAt),
    embedding: (node.embedding as number[]) ?? [],
    entityIds: extras.entityIds ?? [],
    supersedesFactId: (node.supersedesFactId as string | undefined) ?? undefined,
    mergedFromFactIds: (node.mergedFromFactIds as string[] | undefined) ?? undefined,
    sourceEpisodeId: (node.sourceEpisodeId as string | undefined) ?? undefined,
    referenceCount: (node.referenceCount as number | undefined) ?? 0,
    lastReferencedAt: toJsDateOrNull(node.lastReferencedAt),
    supersedeCheckedAt: toJsDateOrNull(node.supersedeCheckedAt),
    agentId: (node.agentId as string | null | undefined) ?? undefined,
    sessionId: (node.sessionId as string | null | undefined) ?? undefined,
    ...readScope(node),
  };
}

export const FactRepository = {
  async create(
    tx: ManagedTransaction,
    fact: Fact,
    opts: { sourceChunkIds?: string[] } = {},
  ): Promise<Fact> {
    // Split into independent statements: a single Cypher with UNWIND of an
    // empty entityIds list would drop the result row entirely.
    const result = await tx.run(
      `MERGE (f:Fact {id: $id})
       SET ${memoryItemSetClause('f')},
           f.content = $content,
           f.category = $category,
           f.confidence = $confidence,
           f.importance = $importance,
           f.validFrom = datetime($validFrom),
           f.validTo = CASE WHEN $validTo IS NULL THEN NULL ELSE datetime($validTo) END,
           f.recordedAt = datetime($recordedAt),
           f.embedding = $embedding,
           f.sourceEpisodeId = $sourceEpisodeId,
           f.mergedFromFactIds = $mergedFromFactIds,
           f.supersedeCheckedAt = CASE
             WHEN $supersedeCheckedAt IS NULL THEN NULL ELSE datetime($supersedeCheckedAt) END,
           f.agentId = $agentId,
           f.sessionId = $sessionId
       RETURN f {.*} AS f`,
      {
        id: fact.id,
        content: fact.content,
        category: fact.category ?? null,
        confidence: fact.confidence,
        importance: fact.importance,
        validFrom: dateParam(fact.validFrom),
        validTo: nullableDateParam(fact.validTo),
        recordedAt: dateParam(fact.recordedAt),
        embedding: fact.embedding,
        sourceEpisodeId: fact.sourceEpisodeId ?? null,
        mergedFromFactIds: fact.mergedFromFactIds ?? null,
        supersedeCheckedAt: nullableDateParam(fact.supersedeCheckedAt ?? null),
        agentId: fact.agentId ?? null,
        sessionId: fact.sessionId ?? null,
        ...memoryItemParams('fact', fact),
      },
    );

    if (fact.entityIds.length > 0) {
      await tx.run(
        `MATCH (f:Fact {id: $factId})
         UNWIND $entityIds AS eid
         MATCH (e:Entity {id: eid})
         MERGE (e)-[:HAS_FACT]->(f)`,
        { factId: fact.id, entityIds: fact.entityIds },
      );
    }

    if (fact.sourceEpisodeId) {
      await tx.run(
        `MATCH (f:Fact {id: $factId}), (src:Episode {id: $episodeId})
         MERGE (src)-[:CONTAINS]->(f)`,
        { factId: fact.id, episodeId: fact.sourceEpisodeId },
      );
    }

    // DERIVED_FROM gives fact-level recall a precise citation: the exact chunk
    // that grounded the extraction. Optional — direct /facts POST won't have
    // chunk provenance, only dream-extracted facts do.
    if (opts.sourceChunkIds && opts.sourceChunkIds.length > 0) {
      await tx.run(
        `MATCH (f:Fact {id: $factId})
         UNWIND $chunkIds AS cid
         MATCH (c:Chunk {id: cid})
         MERGE (f)-[:DERIVED_FROM]->(c)`,
        { factId: fact.id, chunkIds: opts.sourceChunkIds },
      );
    }

    return toFact(result.records[0]!.get('f'), { entityIds: fact.entityIds });
  },

  async get(tx: ManagedTransaction, id: string): Promise<Fact | null> {
    const result = await tx.run(
      `MATCH (f:Fact {id: $id})
       OPTIONAL MATCH (e:Entity)-[:HAS_FACT]->(f)
       RETURN f {.*} AS f, collect(e.id) AS entityIds`,
      { id },
    );
    const record = result.records[0];
    if (!record) return null;
    return toFact(record.get('f'), { entityIds: record.get('entityIds') as string[] });
  },

  /**
   * User/API redaction. Stamps the hard read gate and closes the valid
   * interval ONLY if it is still open.
   *
   * The `coalesce` is load-bearing: deleting a fact that was superseded six
   * months ago used to overwrite its historical event-time `validTo` with
   * `now`, so /timeline and snapshotAt reported the retracted claim as live
   * for that entire window — silent, unrecoverable bi-temporal corruption.
   *
   * Still writes `validTo` as well as `deletedAt` so the ~12 legacy
   * `validTo IS NULL` reads keep excluding deleted facts even if someone
   * forgets the new guard; `deletedAt` is the second layer that also covers
   * the includeSuperseded/asOf paths where `validTo` is deliberately ignored.
   *
   * Returns false when already deleted, so the caller skips a duplicate audit
   * write rather than appending a second soft_delete event per retry.
   */
  async softDelete(tx: ManagedTransaction, id: string, at: Date): Promise<boolean> {
    const result = await tx.run(
      `MATCH (f:Fact {id: $id})
       WHERE f.deletedAt IS NULL
       SET f.deletedAt = datetime($at),
           f.validTo = coalesce(f.validTo, datetime($at))
       RETURN count(f) AS n`,
      { id, at: dateParam(at) },
    );
    return ((result.records[0]?.get('n') as number) ?? 0) > 0;
  },

  /**
   * Decay prune. A transaction-time system forget, NOT a redaction: the claim
   * really did hold, so a pruned fact stays visible to /timeline, `asOf` and
   * `includeSuperseded`. Only `deletedAt` gates reads.
   *
   * The liveness guard stops prune from re-closing an already-superseded
   * fact's event-time `validTo`, the same corruption softDelete had.
   */
  async prune(tx: ManagedTransaction, id: string, at: Date): Promise<boolean> {
    const result = await tx.run(
      `MATCH (f:Fact {id: $id})
       WHERE f.validTo IS NULL AND f.deletedAt IS NULL
       SET f.validTo = datetime($at), f.prunedAt = datetime($at)
       RETURN count(f) AS n`,
      { id, at: dateParam(at) },
    );
    return ((result.records[0]?.get('n') as number) ?? 0) > 0;
  },

  async supersede(
    tx: ManagedTransaction,
    input: {
      oldId: string;
      newId: string;
      reason: string;
      // Event/valid-time end of the old claim (when the world changed).
      validTo: Date;
      // Transaction/decision time on the :SUPERSEDES edge (when we decided).
      supersededAt: Date;
      // Optional adjustment to the *new* (superseding) fact's confidence, as
      // decided by the LLM supersede check. Positive when contradicting prior
      // memory strengthens our certainty in the new claim, negative when it
      // introduces doubt. Applied clamped to [0, 1]. Omit (explicit user-driven
      // supersede) to leave confidence untouched.
      confidenceDelta?: number;
    },
  ): Promise<{ newConfidence: number | null; applied: boolean }> {
    const result = await tx.run(
      // A redacted fact must not be resurrected into a supersede chain, and a
      // second supersede must not move an already-closed event-time validTo.
      // When the guard rejects, no row comes back and `applied` is false, so
      // the caller can skip its audit event and counter bump.
      `MATCH (oldF:Fact {id: $oldId}), (newF:Fact {id: $newId})
       WHERE oldF.deletedAt IS NULL AND newF.deletedAt IS NULL AND oldF.validTo IS NULL
       MERGE (newF)-[r:SUPERSEDES]->(oldF)
       SET r.reason = $reason, r.supersededAt = datetime($supersededAt)
       SET oldF.validTo = datetime($validTo)
       SET newF.supersedesFactId = $oldId
       SET newF.confidence = CASE
         WHEN $confidenceDelta IS NULL THEN newF.confidence
         WHEN newF.confidence + $confidenceDelta > 1.0 THEN 1.0
         WHEN newF.confidence + $confidenceDelta < 0.0 THEN 0.0
         ELSE newF.confidence + $confidenceDelta
       END
       RETURN CASE WHEN $confidenceDelta IS NULL THEN NULL ELSE newF.confidence END AS newConfidence`,
      {
        oldId: input.oldId,
        newId: input.newId,
        reason: input.reason,
        validTo: dateParam(input.validTo),
        supersededAt: dateParam(input.supersededAt),
        confidenceDelta: input.confidenceDelta ?? null,
      },
    );
    const rec = result.records[0];
    return {
      newConfidence: (rec?.get('newConfidence') as number | null) ?? null,
      applied: rec !== undefined,
    };
  },

  // Consolidation merge: persist a canonical fact that replaces N member
  // facts. Lineage lives on the SUPERSEDES edges (+ mergedFromFactIds on the
  // new node); supersedesFactId stays unset — the scalar can't hold N ids.
  // The new fact inherits the members' pooled access telemetry (summed
  // referenceCount, latest lastReferencedAt) so decay-based retention carries
  // over instead of resetting.
  //
  // Members are retired at transaction time (memberValidTo), not event time —
  // they were never "false earlier"; snapshotAt collapses them when a survivor
  // merge covers the as-of instant.
  async mergeFrom(
    tx: ManagedTransaction,
    input: {
      newFact: Fact;
      memberIds: string[];
      reason: string;
      memberValidTo: Date;
      supersededAt: Date;
    },
  ): Promise<Fact> {
    const created = await FactRepository.create(tx, input.newFact);

    await tx.run(
      `MATCH (newF:Fact {id: $newId})
       UNWIND $memberIds AS mid
       MATCH (oldF:Fact {id: mid})
       WHERE oldF.validTo IS NULL AND oldF.deletedAt IS NULL
       MERGE (newF)-[r:SUPERSEDES]->(oldF)
       SET r.reason = $reason, r.supersededAt = datetime($supersededAt)
       SET oldF.validTo = datetime($memberValidTo)`,
      {
        newId: input.newFact.id,
        memberIds: input.memberIds,
        reason: input.reason,
        memberValidTo: dateParam(input.memberValidTo),
        supersededAt: dateParam(input.supersededAt),
      },
    );

    // Union of the members' provenance: chunk citations and episode links.
    await tx.run(
      `MATCH (newF:Fact {id: $newId})
       UNWIND $memberIds AS mid
       MATCH (:Fact {id: mid})-[:DERIVED_FROM]->(c:Chunk)
       MERGE (newF)-[:DERIVED_FROM]->(c)`,
      { newId: input.newFact.id, memberIds: input.memberIds },
    );
    await tx.run(
      `MATCH (newF:Fact {id: $newId})
       UNWIND $memberIds AS mid
       MATCH (ep:Episode)-[:CONTAINS]->(:Fact {id: mid})
       MERGE (ep)-[:CONTAINS]->(newF)`,
      { newId: input.newFact.id, memberIds: input.memberIds },
    );

    const telemetry = await tx.run(
      `MATCH (newF:Fact {id: $newId})
       UNWIND $memberIds AS mid
       MATCH (oldF:Fact {id: mid})
       WITH newF,
            sum(coalesce(oldF.referenceCount, 0)) AS refs,
            max(oldF.lastReferencedAt) AS lastRef
       SET newF.referenceCount = refs, newF.lastReferencedAt = lastRef
       RETURN newF {.*} AS f`,
      { newId: input.newFact.id, memberIds: input.memberIds },
    );
    const node = telemetry.records[0]?.get('f') as Record<string, unknown> | undefined;
    return node ? toFact(node, { entityIds: input.newFact.entityIds }) : created;
  },

  async listSimilar(
    tx: ManagedTransaction,
    input: {
      embedding: number[];
      limit: number;
      minScore?: number;
      includeSuperseded?: boolean;
      // When set, keep only facts whose valid-time interval covers this instant
      // (validFrom ≤ asOf < validTo|∞). Preferred over bare validTo IS NULL so
      // future-dated validFrom and historical as-of queries are correct.
      asOf?: Date | null;
      // When provided, confine the search to a single scope bucket: a project's
      // own facts (projectId === value) or the unscoped "personal" bucket
      // (projectId === null). Used by dreaming so one project's facts can't
      // dedup-skip or supersede another's. Omit for global searches (recall).
      //
      // includeUnscoped widens a project bucket to ALSO see the personal
      // (projectId IS NULL) bucket — so a project episode can dedup/supersede
      // against personal facts, but never another project's. userId acts as a
      // compatibility guard on that widened branch only (a project owned by
      // one human must not dedup against another human's personal facts); it
      // is NOT a bucket axis.
      dedupScope?: { projectId?: string | null; includeUnscoped?: boolean; userId?: string | null };
      // Four-axis retrieval scope, same shape every other repository calls
      // `scope`. Distinct from dedupScope above, which is the dream BUCKET
      // rule; conflating the two names is why this pushdown was never wired.
      scope?: RetrievalScope;
    },
  ): Promise<Array<Fact & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const includeSuperseded = input.includeSuperseded ?? false;
    const asOf = input.asOf ?? null;
    const hasScope = input.dedupScope !== undefined;
    const projectId = input.dedupScope?.projectId ?? null;
    const userId = input.dedupScope?.userId ?? null;
    const includeUnscoped = (input.dedupScope?.includeUnscoped ?? false) && projectId !== null;
    let scopeClause = '';
    if (hasScope) {
      scopeClause = includeUnscoped
        ? `AND (node.projectId = $projectId
               OR (node.projectId IS NULL
                   AND ($userId IS NULL OR node.userId IS NULL OR node.userId = $userId)))`
        : projectId === null
          ? 'AND node.projectId IS NULL'
          : 'AND node.projectId = $projectId';
    }
    const retrieval = scopeAndClause('node', input.scope);
    const result = await tx.run(
      // The asOf interval supersedes the simple validTo IS NULL live filter.
      `CALL db.index.vector.queryNodes('fact_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore
       ${validAtClause('node', { asOf, includeSuperseded })}
       ${scopeClause}
       ${retrieval.clause}
       OPTIONAL MATCH (e:Entity)-[:HAS_FACT]->(node)
       WITH node, score, collect(e.id) AS entityIds
       RETURN node {.*} AS f, entityIds, score
       ORDER BY score DESC`,
      {
        vec: input.embedding,
        limit: input.limit,
        minScore,
        projectId,
        userId,
        asOf: nullableDateParam(asOf),
        ...retrieval.params,
      },
    );
    return result.records.map((r) => ({
      ...toFact(r.get('f'), { entityIds: r.get('entityIds') as string[] }),
      score: r.get('score') as number,
    }));
  },

  async fullTextSearch(
    tx: ManagedTransaction,
    input: { query: string; limit: number; includeSuperseded?: boolean; asOf?: Date | null },
  ): Promise<Array<Fact & { score: number }>> {
    const includeSuperseded = input.includeSuperseded ?? false;
    const asOf = input.asOf ?? null;
    const result = await tx.run(
      `CALL db.index.fulltext.queryNodes('fact_fulltext', $q) YIELD node, score
       WHERE node:Fact
       ${validAtClause('node', { asOf, includeSuperseded })}
       OPTIONAL MATCH (e:Entity)-[:HAS_FACT]->(node)
       WITH node, score, collect(e.id) AS entityIds
       RETURN node {.*} AS f, entityIds, score
       ORDER BY score DESC
       LIMIT toInteger($limit)`,
      { q: input.query, limit: input.limit, asOf: nullableDateParam(asOf) },
    );
    return result.records.map((r) => ({
      ...toFact(r.get('f'), { entityIds: r.get('entityIds') as string[] }),
      score: r.get('score') as number,
    }));
  },

  async snapshotAt(
    tx: ManagedTransaction,
    input: { at: Date; entityId?: string; limit?: number },
  ): Promise<Fact[]> {
    // Valid-time as-of, plus consolidation collapse: a fragment that was merged
    // into a survivor must not double-count when the survivor also covers `at`.
    // Contradiction supersedes are handled by event-time validTo on the old row.
    const result = await tx.run(
      `${input.entityId ? 'MATCH (e:Entity {id: $entityId})-[:HAS_FACT]->(f:Fact)' : 'MATCH (f:Fact)'}
       WHERE f.deletedAt IS NULL
         AND f.validFrom <= datetime($at)
         AND (f.validTo IS NULL OR f.validTo > datetime($at))
         AND NOT EXISTS {
           MATCH (survivor:Fact)
           WHERE survivor.mergedFromFactIds IS NOT NULL
             AND f.id IN survivor.mergedFromFactIds
             AND survivor.validFrom <= datetime($at)
             AND (survivor.validTo IS NULL OR survivor.validTo > datetime($at))
         }
       OPTIONAL MATCH (ent:Entity)-[:HAS_FACT]->(f)
       WITH f, collect(ent.id) AS entityIds
       RETURN f {.*} AS f, entityIds
       ORDER BY f.recordedAt DESC
       LIMIT toInteger($limit)`,
      { at: dateParam(input.at), entityId: input.entityId ?? null, limit: input.limit ?? 100 },
    );
    return result.records.map((r) =>
      toFact(r.get('f'), { entityIds: r.get('entityIds') as string[] }),
    );
  },

  async listForEntity(
    tx: ManagedTransaction,
    input: { entityId: string; includeSuperseded?: boolean },
  ): Promise<Fact[]> {
    const includeSuperseded = input.includeSuperseded ?? false;
    const result = await tx.run(
      `MATCH (e:Entity {id: $entityId})-[:HAS_FACT]->(f:Fact)
       WHERE f.deletedAt IS NULL${includeSuperseded ? '' : ' AND f.validTo IS NULL'}
       OPTIONAL MATCH (other:Entity)-[:HAS_FACT]->(f)
       WITH f, collect(other.id) AS entityIds
       RETURN f {.*} AS f, entityIds
       ORDER BY f.importance DESC, f.recordedAt DESC`,
      { entityId: input.entityId },
    );
    return result.records.map((r) =>
      toFact(r.get('f'), { entityIds: r.get('entityIds') as string[] }),
    );
  },

  // Live facts whose contradiction check has not run: everything written
  // through POST /facts (which no longer waits on an LLM) plus anything that
  // predates the property. Ordered oldest-first so a backlog drains in the
  // order it arrived. `before` excludes facts written moments ago, so a fact
  // still being written when the cycle started is left for the next one.
  async listPendingSupersedeCheck(
    tx: ManagedTransaction,
    input: { limit: number; before: Date },
  ): Promise<Fact[]> {
    const result = await tx.run(
      `MATCH (f:Fact)
       WHERE f.supersedeCheckedAt IS NULL
         AND f.deletedAt IS NULL
         AND f.validTo IS NULL
         AND f.recordedAt <= datetime($before)
       OPTIONAL MATCH (e:Entity)-[:HAS_FACT]->(f)
       WITH f, collect(e.id) AS entityIds
       RETURN f {.*} AS f, entityIds
       ORDER BY f.recordedAt ASC
       LIMIT toInteger($limit)`,
      { limit: input.limit, before: dateParam(input.before) },
    );
    return result.records.map((r) =>
      toFact(r.get('f'), { entityIds: r.get('entityIds') as string[] }),
    );
  },

  // Mark the check as done, whatever its outcome. A fact that survived the
  // check and one that superseded something are equally finished with it; only
  // an error leaves the stamp unset, which is what makes the sweep retry it.
  async markSupersedeChecked(tx: ManagedTransaction, ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await tx.run(`MATCH (f:Fact) WHERE f.id IN $ids SET f.supersedeCheckedAt = datetime($at)`, {
      ids,
      at: dateParam(at),
    });
  },

  async incrementReferenceCount(tx: ManagedTransaction, id: string): Promise<void> {
    await tx.run(
      `MATCH (f:Fact {id: $id})
       SET f.referenceCount = coalesce(f.referenceCount, 0) + 1,
           f.lastReferencedAt = datetime()`,
      { id },
    );
  },

  // Batched variant used by the retrieval refcount tick.
  async bulkIncrementReferenceCounts(tx: ManagedTransaction, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.run(
      `UNWIND $ids AS id
       MATCH (f:Fact {id: id})
       SET f.referenceCount = coalesce(f.referenceCount, 0) + 1,
           f.lastReferencedAt = datetime()`,
      { ids },
    );
  },

  // Facts reachable from a set of chunks via :DERIVED_FROM. Used by the
  // ChunkToFactProjector stage to promote chunk hits into fact candidates
  // even when the same fact wasn't a direct vector/FT match.
  async fromChunks(
    tx: ManagedTransaction,
    input: { chunkIds: string[]; includeSuperseded?: boolean },
  ): Promise<Array<Fact & { sourceChunkIds: string[] }>> {
    if (input.chunkIds.length === 0) return [];
    const includeSuperseded = input.includeSuperseded ?? false;
    const result = await tx.run(
      `UNWIND $chunkIds AS cid
       MATCH (c:Chunk {id: cid})<-[:DERIVED_FROM]-(f:Fact)
       WHERE f.deletedAt IS NULL AND ($includeSuperseded OR f.validTo IS NULL)
       WITH DISTINCT f, collect(DISTINCT cid) AS sourceChunkIds
       OPTIONAL MATCH (e:Entity)-[:HAS_FACT]->(f)
       WITH f, sourceChunkIds, collect(DISTINCT e.id) AS entityIds
       RETURN f {.*} AS f, entityIds, sourceChunkIds`,
      { chunkIds: input.chunkIds, includeSuperseded },
    );
    return result.records.map((r) => ({
      ...toFact(r.get('f'), { entityIds: r.get('entityIds') as string[] }),
      sourceChunkIds: r.get('sourceChunkIds') as string[],
    }));
  },

  // 1-hop entity sibling expansion: return facts that share ANY of the given
  // entities with already-seen seeds, excluding the seeds themselves. Ordered
  // by importance desc so the cap preserves the most-relevant siblings.
  async siblingFactsByEntity(
    tx: ManagedTransaction,
    input: {
      entityIds: string[];
      excludeFactIds: string[];
      limit: number;
      includeSuperseded?: boolean;
    },
  ): Promise<Fact[]> {
    if (input.entityIds.length === 0) return [];
    const includeSuperseded = input.includeSuperseded ?? false;
    const result = await tx.run(
      `UNWIND $entityIds AS eid
       MATCH (e:Entity {id: eid})-[:HAS_FACT]->(f:Fact)
       WHERE NOT f.id IN $excludeFactIds
         AND f.deletedAt IS NULL
         AND ($includeSuperseded OR f.validTo IS NULL)
       WITH DISTINCT f
       OPTIONAL MATCH (e2:Entity)-[:HAS_FACT]->(f)
       WITH f, collect(DISTINCT e2.id) AS entityIds
       RETURN f {.*} AS f, entityIds
       ORDER BY f.importance DESC, f.recordedAt DESC
       LIMIT toInteger($limit)`,
      {
        entityIds: input.entityIds,
        excludeFactIds: input.excludeFactIds,
        limit: input.limit,
        includeSuperseded,
      },
    );
    return result.records.map((r) =>
      toFact(r.get('f'), { entityIds: r.get('entityIds') as string[] }),
    );
  },

  // HippoRAG-style retrieval: run Personalized PageRank over the GDS projection
  // (`memgraph`, built by the dream cycle) seeded from the given entities, and
  // return the highest-PageRank Fact nodes. Facts accrue mass through HAS_FACT /
  // RELATES / SYNONYM edges, so this surfaces multi-hop-relevant facts that a
  // direct vector/FT match misses. Throws if the projection is missing or GDS
  // rejects a seed — the calling stage catches and degrades to dense+sparse.
  async pprFactsByEntities(
    tx: ManagedTransaction,
    input: {
      seedEntityIds: string[];
      excludeFactIds: string[];
      limit: number;
      includeSuperseded?: boolean;
      graphName: string;
      dampingFactor: number;
      maxIterations: number;
    },
  ): Promise<Array<Fact & { score: number }>> {
    if (input.seedEntityIds.length === 0) return [];
    const includeSuperseded = input.includeSuperseded ?? false;
    const result = await tx.run(
      `MATCH (seed:Entity) WHERE seed.id IN $seedEntityIds
       WITH collect(id(seed)) AS sourceIds
       CALL gds.pageRank.stream($graphName, {
         sourceNodes: sourceIds,
         dampingFactor: $dampingFactor,
         maxIterations: toInteger($maxIterations)
       }) YIELD nodeId, score
       WITH gds.util.asNode(nodeId) AS node, score
       WHERE node:Fact
         AND NOT node.id IN $excludeFactIds
         AND node.deletedAt IS NULL
         AND ($includeSuperseded OR node.validTo IS NULL)
         AND score > 0
       OPTIONAL MATCH (e:Entity)-[:HAS_FACT]->(node)
       WITH node, score, collect(e.id) AS entityIds
       RETURN node {.*} AS f, entityIds, score
       ORDER BY score DESC
       LIMIT toInteger($limit)`,
      {
        seedEntityIds: input.seedEntityIds,
        excludeFactIds: input.excludeFactIds,
        limit: input.limit,
        includeSuperseded,
        graphName: input.graphName,
        dampingFactor: input.dampingFactor,
        maxIterations: input.maxIterations,
      },
    );
    return result.records.map((r) => ({
      ...toFact(r.get('f'), { entityIds: r.get('entityIds') as string[] }),
      score: r.get('score') as number,
    }));
  },
};
