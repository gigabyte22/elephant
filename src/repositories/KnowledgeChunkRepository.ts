import type { ManagedTransaction } from 'neo4j-driver';
import type { KnowledgeChunk } from '../models/types.ts';
import { dateParam, toJsDate } from '../utils/neo4j-conv.ts';
import { type RetrievalScope, readScope, scopeAndClause } from './scope.ts';

function toKnowledgeChunk(node: Record<string, unknown>): KnowledgeChunk {
  return {
    id: node.id as string,
    documentId: node.documentId as string,
    attachmentId: (node.attachmentId as string | undefined) ?? undefined,
    position: node.position as number,
    text: node.text as string,
    tokenCount: node.tokenCount as number,
    embedding: (node.embedding as number[]) ?? [],
    createdAt: toJsDate(node.createdAt),
    ...readScope(node),
  };
}

export const KnowledgeChunkRepository = {
  // Create all chunks of a single KnowledgeDocument atomically. Mirrors the
  // Episode/Chunk pattern: (Document)-[:HAS_CHUNK]->(KnowledgeChunk) and
  // (KnowledgeChunk)-[:NEXT]->(KnowledgeChunk) for adjacency.
  async createForDocument(
    tx: ManagedTransaction,
    input: { documentId: string; chunks: KnowledgeChunk[] },
  ): Promise<void> {
    if (input.chunks.length === 0) return;

    await tx.run(
      `MATCH (d:KnowledgeDocument {id: $documentId})
       UNWIND $chunks AS c
       MERGE (ch:KnowledgeChunk {id: c.id})
       SET ch:MemoryItem,
           ch.kind = 'knowledge_chunk',
           ch.documentId = $documentId,
           ch.attachmentId = c.attachmentId,
           ch.position = c.position,
           ch.text = c.text,
           ch.tokenCount = c.tokenCount,
           ch.embedding = c.embedding,
           ch.createdAt = datetime(c.createdAt),
           ch.projectId = c.projectId,
           ch.userId = c.userId
       MERGE (d)-[r:HAS_CHUNK]->(ch)
       SET r.position = c.position
       MERGE (ch)-[:FROM_DOCUMENT]->(d)`,
      {
        documentId: input.documentId,
        chunks: input.chunks.map((c) => ({
          id: c.id,
          attachmentId: c.attachmentId ?? null,
          position: c.position,
          text: c.text,
          tokenCount: c.tokenCount,
          embedding: c.embedding,
          createdAt: dateParam(c.createdAt),
          projectId: c.projectId ?? null,
          userId: c.userId ?? null,
        })),
      },
    );

    if (input.chunks.length > 1) {
      const ordered = input.chunks.slice().sort((a, b) => a.position - b.position);
      const pairs = ordered.slice(0, -1).map((c, i) => ({ from: c.id, to: ordered[i + 1]!.id }));
      await tx.run(
        `UNWIND $pairs AS p
         MATCH (a:KnowledgeChunk {id: p.from}), (b:KnowledgeChunk {id: p.to})
         MERGE (a)-[:NEXT]->(b)`,
        { pairs },
      );
    }
  },

  async listByDocument(tx: ManagedTransaction, documentId: string): Promise<KnowledgeChunk[]> {
    const result = await tx.run(
      `MATCH (d:KnowledgeDocument {id: $documentId})-[:HAS_CHUNK]->(c:KnowledgeChunk)
       RETURN c {.*} AS c
       ORDER BY c.position ASC`,
      { documentId },
    );
    return result.records.map((r) => toKnowledgeChunk(r.get('c')));
  },

  async listSimilar(
    tx: ManagedTransaction,
    input: {
      embedding: number[];
      limit: number;
      minScore?: number;
      scope?: RetrievalScope;
    },
  ): Promise<Array<KnowledgeChunk & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const { clause, params } = scopeAndClause('node', input.scope);
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('knowledgechunk_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore ${clause}
       RETURN node {.*} AS c, score
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore, ...params },
    );
    return result.records.map((r) => ({
      ...toKnowledgeChunk(r.get('c')),
      score: r.get('score') as number,
    }));
  },

  async fullTextSearch(
    tx: ManagedTransaction,
    input: { query: string; limit: number; scope?: RetrievalScope },
  ): Promise<Array<KnowledgeChunk & { score: number }>> {
    const { clause, params } = scopeAndClause('node', input.scope);
    const result = await tx.run(
      `CALL db.index.fulltext.queryNodes('knowledge_chunk_fulltext', $q) YIELD node, score
       WHERE node:KnowledgeChunk ${clause}
       RETURN node {.*} AS c, score
       ORDER BY score DESC
       LIMIT toInteger($limit)`,
      { q: input.query, limit: input.limit, ...params },
    );
    return result.records.map((r) => ({
      ...toKnowledgeChunk(r.get('c')),
      score: r.get('score') as number,
    }));
  },

  async deleteForDocument(tx: ManagedTransaction, documentId: string): Promise<number> {
    return deleteChunks(tx, 'MATCH (c:KnowledgeChunk {documentId: $documentId})', { documentId });
  },

  // Delete only the note-body chunks (no attachmentId), leaving attachment-
  // derived chunks intact. Used when re-indexing edited note content.
  async deleteBodyChunks(tx: ManagedTransaction, documentId: string): Promise<number> {
    return deleteChunks(
      tx,
      'MATCH (c:KnowledgeChunk {documentId: $documentId}) WHERE c.attachmentId IS NULL',
      { documentId },
    );
  },

  async deleteForAttachment(tx: ManagedTransaction, attachmentId: string): Promise<number> {
    return deleteChunks(tx, 'MATCH (c:KnowledgeChunk {attachmentId: $attachmentId})', {
      attachmentId,
    });
  },
};

// Detach-delete the chunks selected by `matchClause` and return the count.
async function deleteChunks(
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
