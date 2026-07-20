// Parameterized chunk repository shared by KnowledgeChunk and ResearchChunk.
// Both kinds keep separate labels and separate vector/fulltext indexes on
// purpose: Neo4j vector queries can't pre-filter, so a shared index would
// shrink effective top-K and leak one kind into the other's recall. The
// factory removes the code duplication without merging the indexes.

import type { ManagedTransaction } from 'neo4j-driver';
import { dateParam } from '../utils/neo4j-conv.ts';
import { type RetrievalScope, scopeAndClause } from './scope.ts';

// Property shape every chunk row shares; per-kind extras (e.g. knowledge's
// attachmentId) go through `extraChunkProps`.
export interface BaseChunkRow {
  id: string;
  position: number;
  text: string;
  tokenCount: number;
  embedding: number[];
  createdAt: Date;
  projectId?: string | null;
  userId?: string | null;
}

export interface ChunkRepositoryConfig<T extends BaseChunkRow> {
  label: string; // 'KnowledgeChunk' | 'ResearchChunk'
  kind: string; // stamped as ch.kind
  parentLabel: string; // 'KnowledgeDocument' | 'Research'
  parentEdge: string; // 'FROM_DOCUMENT' | 'FROM_RESEARCH'
  parentIdProp: string; // 'documentId' | 'researchId'
  vectorIndex: string;
  fulltextIndex: string;
  mapNode: (node: Record<string, unknown>) => T;
  // Extra per-chunk SET fragment + params (e.g. 'ch.attachmentId = c.attachmentId').
  extraChunkProps?: {
    set: string;
    params: (chunk: T) => Record<string, unknown>;
  };
  // When true, search results are joined to the parent and filtered on its
  // expiresAt — required for expirable parents (Research) so lapsed or
  // soft-deleted items can't resurface through their chunks.
  parentLivenessGuard?: boolean;
}

export interface ChunkRepositoryCore<T extends BaseChunkRow> {
  createForParent(tx: ManagedTransaction, input: { parentId: string; chunks: T[] }): Promise<void>;
  listByParent(tx: ManagedTransaction, parentId: string): Promise<T[]>;
  listSimilar(
    tx: ManagedTransaction,
    input: { embedding: number[]; limit: number; minScore?: number; scope?: RetrievalScope },
  ): Promise<Array<T & { score: number }>>;
  fullTextSearch(
    tx: ManagedTransaction,
    input: { query: string; limit: number; scope?: RetrievalScope },
  ): Promise<Array<T & { score: number }>>;
  deleteForParent(tx: ManagedTransaction, parentId: string): Promise<number>;
}

export function createChunkRepository<T extends BaseChunkRow>(
  cfg: ChunkRepositoryConfig<T>,
): ChunkRepositoryCore<T> {
  const { label, kind, parentLabel, parentEdge, parentIdProp, vectorIndex, fulltextIndex } = cfg;
  const extraSet = cfg.extraChunkProps ? `${cfg.extraChunkProps.set},\n           ` : '';
  // MATCH-after-WHERE continues the Cypher pipeline: rows whose parent is
  // expired (or missing) drop out before RETURN.
  const livenessGuard = cfg.parentLivenessGuard
    ? `MATCH (node)-[:${parentEdge}]->(parent:${parentLabel})
       WHERE parent.expiresAt IS NULL OR parent.expiresAt > datetime()`
    : '';

  return {
    // Create all chunks of a single parent atomically. Mirrors the
    // Episode/Chunk pattern: (parent)-[:HAS_CHUNK]->(chunk) and
    // (chunk)-[:NEXT]->(chunk) for adjacency.
    async createForParent(
      tx: ManagedTransaction,
      input: { parentId: string; chunks: T[] },
    ): Promise<void> {
      if (input.chunks.length === 0) return;

      await tx.run(
        `MATCH (p:${parentLabel} {id: $parentId})
         UNWIND $chunks AS c
         MERGE (ch:${label} {id: c.id})
         SET ch:MemoryItem,
             ch.kind = '${kind}',
             ch.${parentIdProp} = $parentId,
             ${extraSet}ch.position = c.position,
             ch.text = c.text,
             ch.tokenCount = c.tokenCount,
             ch.embedding = c.embedding,
             ch.createdAt = datetime(c.createdAt),
             ch.projectId = c.projectId,
             ch.userId = c.userId
         MERGE (p)-[r:HAS_CHUNK]->(ch)
         SET r.position = c.position
         MERGE (ch)-[:${parentEdge}]->(p)`,
        {
          parentId: input.parentId,
          chunks: input.chunks.map((c) => ({
            id: c.id,
            position: c.position,
            text: c.text,
            tokenCount: c.tokenCount,
            embedding: c.embedding,
            createdAt: dateParam(c.createdAt),
            projectId: c.projectId ?? null,
            userId: c.userId ?? null,
            ...(cfg.extraChunkProps?.params(c) ?? {}),
          })),
        },
      );

      if (input.chunks.length > 1) {
        const ordered = input.chunks.slice().sort((a, b) => a.position - b.position);
        const pairs = ordered.slice(0, -1).map((c, i) => ({ from: c.id, to: ordered[i + 1]!.id }));
        await tx.run(
          `UNWIND $pairs AS p
           MATCH (a:${label} {id: p.from}), (b:${label} {id: p.to})
           MERGE (a)-[:NEXT]->(b)`,
          { pairs },
        );
      }
    },

    async listByParent(tx: ManagedTransaction, parentId: string): Promise<T[]> {
      const result = await tx.run(
        `MATCH (p:${parentLabel} {id: $parentId})-[:HAS_CHUNK]->(c:${label})
         RETURN c {.*} AS c
         ORDER BY c.position ASC`,
        { parentId },
      );
      return result.records.map((r) => cfg.mapNode(r.get('c')));
    },

    async listSimilar(
      tx: ManagedTransaction,
      input: { embedding: number[]; limit: number; minScore?: number; scope?: RetrievalScope },
    ): Promise<Array<T & { score: number }>> {
      const minScore = input.minScore ?? 0;
      const { clause, params } = scopeAndClause('node', input.scope);
      const result = await tx.run(
        `CALL db.index.vector.queryNodes('${vectorIndex}', toInteger($limit), $vec) YIELD node, score
         WHERE score >= $minScore ${clause}
         ${livenessGuard}
         RETURN node {.*} AS c, score
         ORDER BY score DESC`,
        { vec: input.embedding, limit: input.limit, minScore, ...params },
      );
      return result.records.map((r) => ({
        ...cfg.mapNode(r.get('c')),
        score: r.get('score') as number,
      }));
    },

    async fullTextSearch(
      tx: ManagedTransaction,
      input: { query: string; limit: number; scope?: RetrievalScope },
    ): Promise<Array<T & { score: number }>> {
      const { clause, params } = scopeAndClause('node', input.scope);
      const result = await tx.run(
        `CALL db.index.fulltext.queryNodes('${fulltextIndex}', $q) YIELD node, score
         WHERE node:${label} ${clause}
         ${livenessGuard}
         RETURN node {.*} AS c, score
         ORDER BY score DESC
         LIMIT toInteger($limit)`,
        { q: input.query, limit: input.limit, ...params },
      );
      return result.records.map((r) => ({
        ...cfg.mapNode(r.get('c')),
        score: r.get('score') as number,
      }));
    },

    async deleteForParent(tx: ManagedTransaction, parentId: string): Promise<number> {
      return deleteChunksWhere(tx, `MATCH (c:${label} {${parentIdProp}: $parentId})`, {
        parentId,
      });
    },
  };
}

// Detach-delete the chunks selected by `matchClause` and return the count.
// Exported so per-kind repositories can layer extra deletes (e.g. knowledge's
// attachment-scoped variants) on the same idiom.
export async function deleteChunksWhere(
  tx: ManagedTransaction,
  matchClause: string,
  params: Record<string, string>,
): Promise<number> {
  const result = await tx.run(
    `${matchClause}
     WITH collect(c) AS cs, count(*) AS n
     FOREACH (c IN cs | DETACH DELETE c)
     RETURN n`,
    params,
  );
  return (result.records[0]?.get('n') as number) ?? 0;
}
