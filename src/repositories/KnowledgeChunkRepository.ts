import type { ManagedTransaction } from 'neo4j-driver';
import type { ChunkDerivation, KnowledgeChunk } from '../models/types.ts';
import { toJsDate } from '../utils/neo4j-conv.ts';
import { createChunkRepository, deleteChunksWhere } from './chunk-repository-factory.ts';
import { type RetrievalScope, readScope } from './scope.ts';

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
    // Absent on chunks written before these properties existed: body text was
    // always verbatim, and an unrecorded overlap is the one the caller cannot
    // strip anyway.
    derivation: (node.derivation as ChunkDerivation | undefined) ?? 'verbatim',
    overlapChars: (node.overlapChars as number | undefined) ?? 0,
    ...readScope(node),
  };
}

// Knowledge documents expire and soft-delete the same way research does
// (softDelete = set expiresAt = now), so every search must join the parent and
// drop chunks whose document has lapsed or been deleted. Without this,
// DELETE /knowledge/documents/:id reported {deleted:true}, the document
// vanished from GET /knowledge/documents, and its full text kept coming back
// in /recall forever — the chunks were only removed under ?purge=true.
const core = createChunkRepository<KnowledgeChunk>({
  label: 'KnowledgeChunk',
  kind: 'knowledge_chunk',
  parentLabel: 'KnowledgeDocument',
  parentEdge: 'FROM_DOCUMENT',
  parentIdProp: 'documentId',
  vectorIndex: 'knowledgechunk_vectors',
  fulltextIndex: 'knowledge_chunk_fulltext',
  mapNode: toKnowledgeChunk,
  parentLivenessGuard: true,
  extraChunkProps: {
    set: [
      'ch.attachmentId = c.attachmentId',
      'ch.derivation = c.derivation',
      'ch.overlapChars = c.overlapChars',
    ],
    params: (c) => ({
      attachmentId: c.attachmentId ?? null,
      derivation: c.derivation,
      overlapChars: c.overlapChars,
    }),
  },
});

export const KnowledgeChunkRepository = {
  async createForDocument(
    tx: ManagedTransaction,
    input: { documentId: string; chunks: KnowledgeChunk[] },
  ): Promise<void> {
    return core.createForParent(tx, { parentId: input.documentId, chunks: input.chunks });
  },

  async listByDocument(tx: ManagedTransaction, documentId: string): Promise<KnowledgeChunk[]> {
    return core.listByParent(tx, documentId);
  },

  async listSimilar(
    tx: ManagedTransaction,
    input: { embedding: number[]; limit: number; minScore?: number; scope?: RetrievalScope },
  ): Promise<Array<KnowledgeChunk & { score: number }>> {
    return core.listSimilar(tx, input);
  },

  async fullTextSearch(
    tx: ManagedTransaction,
    input: { query: string; limit: number; scope?: RetrievalScope },
  ): Promise<Array<KnowledgeChunk & { score: number }>> {
    return core.fullTextSearch(tx, input);
  },

  async deleteForDocument(tx: ManagedTransaction, documentId: string): Promise<number> {
    return core.deleteForParent(tx, documentId);
  },

  // Delete only the note-body chunks (no attachmentId), leaving attachment-
  // derived chunks intact. Used when re-indexing edited note content.
  async deleteBodyChunks(tx: ManagedTransaction, documentId: string): Promise<number> {
    return deleteChunksWhere(
      tx,
      'MATCH (c:KnowledgeChunk {documentId: $documentId}) WHERE c.attachmentId IS NULL',
      { documentId },
    );
  },

  async deleteForAttachment(tx: ManagedTransaction, attachmentId: string): Promise<number> {
    return deleteChunksWhere(tx, 'MATCH (c:KnowledgeChunk {attachmentId: $attachmentId})', {
      attachmentId,
    });
  },
};
