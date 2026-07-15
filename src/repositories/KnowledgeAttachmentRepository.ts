import type { ManagedTransaction } from 'neo4j-driver';
import type { KnowledgeAttachment } from '../models/types.ts';
import { dateParam, toJsDate } from '../utils/neo4j-conv.ts';
import { readScope } from './scope.ts';

function toKnowledgeAttachment(node: Record<string, unknown>): KnowledgeAttachment {
  return {
    id: node.id as string,
    documentId: node.documentId as string,
    filename: node.filename as string,
    mimeType: node.mimeType as string,
    size: node.size as number,
    sha256: node.sha256 as string,
    blobId: node.blobId as string,
    extractionStatus: node.extractionStatus as KnowledgeAttachment['extractionStatus'],
    extractedChars: (node.extractedChars as number) ?? 0,
    detail: (node.detail as string | undefined) ?? undefined,
    createdAt: toJsDate(node.createdAt),
    ...readScope(node),
  };
}

export const KnowledgeAttachmentRepository = {
  // Attach to a document: (d)-[:HAS_ATTACHMENT]->(a:KnowledgeAttachment).
  async create(tx: ManagedTransaction, att: KnowledgeAttachment): Promise<KnowledgeAttachment> {
    const result = await tx.run(
      `MATCH (d:KnowledgeDocument {id: $documentId})
       CREATE (a:KnowledgeAttachment {
         id: $id, documentId: $documentId, filename: $filename, mimeType: $mimeType,
         size: $size, sha256: $sha256, blobId: $blobId, extractionStatus: $extractionStatus,
         extractedChars: $extractedChars, detail: $detail, createdAt: datetime($createdAt),
         projectId: $projectId, userId: $userId
       })
       MERGE (d)-[:HAS_ATTACHMENT]->(a)
       RETURN a {.*} AS a`,
      {
        id: att.id,
        documentId: att.documentId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        sha256: att.sha256,
        blobId: att.blobId,
        extractionStatus: att.extractionStatus,
        extractedChars: att.extractedChars,
        detail: att.detail ?? null,
        createdAt: dateParam(att.createdAt),
        projectId: att.projectId ?? null,
        userId: att.userId ?? null,
      },
    );
    return toKnowledgeAttachment(result.records[0]?.get('a'));
  },

  async listByDocument(tx: ManagedTransaction, documentId: string): Promise<KnowledgeAttachment[]> {
    const result = await tx.run(
      `MATCH (d:KnowledgeDocument {id: $documentId})-[:HAS_ATTACHMENT]->(a:KnowledgeAttachment)
       RETURN a {.*} AS a
       ORDER BY a.createdAt ASC`,
      { documentId },
    );
    return result.records.map((r) => toKnowledgeAttachment(r.get('a')));
  },

  async getById(tx: ManagedTransaction, id: string): Promise<KnowledgeAttachment | null> {
    const result = await tx.run('MATCH (a:KnowledgeAttachment {id: $id}) RETURN a {.*} AS a', {
      id,
    });
    const row = result.records[0];
    return row ? toKnowledgeAttachment(row.get('a')) : null;
  },

  async getByBlobId(tx: ManagedTransaction, blobId: string): Promise<KnowledgeAttachment | null> {
    const result = await tx.run(
      'MATCH (a:KnowledgeAttachment {blobId: $blobId}) RETURN a {.*} AS a',
      { blobId },
    );
    const row = result.records[0];
    return row ? toKnowledgeAttachment(row.get('a')) : null;
  },

  async delete(tx: ManagedTransaction, id: string): Promise<void> {
    await tx.run('MATCH (a:KnowledgeAttachment {id: $id}) DETACH DELETE a', { id });
  },

  async deleteForDocument(tx: ManagedTransaction, documentId: string): Promise<void> {
    await tx.run(
      `MATCH (d:KnowledgeDocument {id: $documentId})-[:HAS_ATTACHMENT]->(a:KnowledgeAttachment)
       DETACH DELETE a`,
      { documentId },
    );
  },
};
