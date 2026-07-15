import type { ManagedTransaction } from 'neo4j-driver';
import type { Fact } from '../models/types.ts';
import { dateParam, nullableDateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import { memoryItemParams, memoryItemSetClause, readScope } from './scope.ts';

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
    embedding: (node.embedding as number[]) ?? [],
    entityIds: extras.entityIds ?? [],
    supersedesFactId: (node.supersedesFactId as string | undefined) ?? undefined,
    mergedFromFactIds: (node.mergedFromFactIds as string[] | undefined) ?? undefined,
    sourceEpisodeId: (node.sourceEpisodeId as string | undefined) ?? undefined,
    referenceCount: (node.referenceCount as number | undefined) ?? 0,
    lastReferencedAt: toJsDateOrNull(node.lastReferencedAt),
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
           f.mergedFromFactIds = $mergedFromFactIds
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

  async softDelete(tx: ManagedTransaction, id: string, at: Date): Promise<void> {
    await tx.run(
      `MATCH (f:Fact {id: $id})
       SET f.validTo = datetime($at)`,
      { id, at: dateParam(at) },
    );
  },

  async supersede(
    tx: ManagedTransaction,
    input: {
      oldId: string;
      newId: string;
      reason: string;
      at: Date;
      // Optional adjustment to the *new* (superseding) fact's confidence, as
      // decided by the LLM supersede check. Positive when contradicting prior
      // memory strengthens our certainty in the new claim, negative when it
      // introduces doubt. Applied clamped to [0, 1]. Omit (explicit user-driven
      // supersede) to leave confidence untouched.
      confidenceDelta?: number;
    },
  ): Promise<{ newConfidence: number | null }> {
    const result = await tx.run(
      `MATCH (oldF:Fact {id: $oldId}), (newF:Fact {id: $newId})
       MERGE (newF)-[r:SUPERSEDES]->(oldF)
       SET r.reason = $reason, r.supersededAt = datetime($at)
       SET oldF.validTo = datetime($at)
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
        at: dateParam(input.at),
        confidenceDelta: input.confidenceDelta ?? null,
      },
    );
    const rec = result.records[0];
    return { newConfidence: (rec?.get('newConfidence') as number | null) ?? null };
  },

  // Consolidation merge: persist a canonical fact that replaces N member
  // facts. Lineage lives on the SUPERSEDES edges (+ mergedFromFactIds on the
  // new node); supersedesFactId stays unset — the scalar can't hold N ids.
  // The new fact inherits the members' pooled access telemetry (summed
  // referenceCount, latest lastReferencedAt) so decay-based retention carries
  // over instead of resetting.
  async mergeFrom(
    tx: ManagedTransaction,
    input: { newFact: Fact; memberIds: string[]; reason: string; at: Date },
  ): Promise<Fact> {
    const created = await FactRepository.create(tx, input.newFact);

    await tx.run(
      `MATCH (newF:Fact {id: $newId})
       UNWIND $memberIds AS mid
       MATCH (oldF:Fact {id: mid})
       MERGE (newF)-[r:SUPERSEDES]->(oldF)
       SET r.reason = $reason, r.supersededAt = datetime($at)
       SET oldF.validTo = datetime($at)`,
      {
        newId: input.newFact.id,
        memberIds: input.memberIds,
        reason: input.reason,
        at: dateParam(input.at),
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
      scope?: { projectId?: string | null; includeUnscoped?: boolean; userId?: string | null };
    },
  ): Promise<Array<Fact & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const includeSuperseded = input.includeSuperseded ?? false;
    const hasScope = input.scope !== undefined;
    const projectId = input.scope?.projectId ?? null;
    const userId = input.scope?.userId ?? null;
    const includeUnscoped = (input.scope?.includeUnscoped ?? false) && projectId !== null;
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
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('fact_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore
       ${includeSuperseded ? '' : 'AND node.validTo IS NULL'}
       ${scopeClause}
       OPTIONAL MATCH (e:Entity)-[:HAS_FACT]->(node)
       WITH node, score, collect(e.id) AS entityIds
       RETURN node {.*} AS f, entityIds, score
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore, projectId, userId },
    );
    return result.records.map((r) => ({
      ...toFact(r.get('f'), { entityIds: r.get('entityIds') as string[] }),
      score: r.get('score') as number,
    }));
  },

  async fullTextSearch(
    tx: ManagedTransaction,
    input: { query: string; limit: number; includeSuperseded?: boolean },
  ): Promise<Array<Fact & { score: number }>> {
    const includeSuperseded = input.includeSuperseded ?? false;
    const result = await tx.run(
      `CALL db.index.fulltext.queryNodes('fact_fulltext', $q) YIELD node, score
       WHERE node:Fact ${includeSuperseded ? '' : 'AND node.validTo IS NULL'}
       OPTIONAL MATCH (e:Entity)-[:HAS_FACT]->(node)
       WITH node, score, collect(e.id) AS entityIds
       RETURN node {.*} AS f, entityIds, score
       ORDER BY score DESC
       LIMIT toInteger($limit)`,
      { q: input.query, limit: input.limit },
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
    const result = await tx.run(
      `${input.entityId ? 'MATCH (e:Entity {id: $entityId})-[:HAS_FACT]->(f:Fact)' : 'MATCH (f:Fact)'}
       WHERE f.validFrom <= datetime($at)
         AND (f.validTo IS NULL OR f.validTo > datetime($at))
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
       ${includeSuperseded ? '' : 'WHERE f.validTo IS NULL'}
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
       WHERE $includeSuperseded OR f.validTo IS NULL
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
