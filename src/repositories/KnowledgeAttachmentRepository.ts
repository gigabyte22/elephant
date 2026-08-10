import type { ManagedTransaction } from 'neo4j-driver';
import type { KnowledgeAttachment } from '../models/types.ts';
import { dateParam, nullableDateParam, toJsDate } from '../utils/neo4j-conv.ts';
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
    extractionAttempts: (node.extractionAttempts as number | undefined) ?? 0,
    extractionNextAttemptAt: node.extractionNextAttemptAt
      ? toJsDate(node.extractionNextAttemptAt)
      : null,
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

  // Record the outcome of a (re-)extraction. Only these three fields ever change
  // after creation — the bytes, hash and scope are immutable.
  async update(
    tx: ManagedTransaction,
    id: string,
    patch: {
      extractionStatus: KnowledgeAttachment['extractionStatus'];
      extractedChars: number;
      detail?: string;
    },
  ): Promise<KnowledgeAttachment | null> {
    const result = await tx.run(
      // Clearing the retry state here is what makes a recovered attachment a
      // clean row again: this method records the outcome of an extraction that
      // ran to completion, so whatever backoff got it here is spent. Failures
      // go through recordExtractionFailure instead.
      `MATCH (a:KnowledgeAttachment {id: $id})
       SET a.extractionStatus = $extractionStatus,
           a.extractedChars = $extractedChars,
           a.detail = $detail,
           a.extractionAttempts = 0,
           a.extractionNextAttemptAt = NULL
       RETURN a {.*} AS a`,
      {
        id,
        extractionStatus: patch.extractionStatus,
        extractedChars: patch.extractedChars,
        detail: patch.detail ?? null,
      },
    );
    const row = result.records[0];
    return row ? toKnowledgeAttachment(row.get('a')) : null;
  },

  // The worker's claim query: pending attachments that are due. A row backing
  // off after a failure stays out of the way until its next attempt time,
  // which is what stops one broken attachment from consuming every tick and
  // starving the queue behind it. Mirrors EpisodeRepository.listPendingDream.
  async listDueForExtraction(
    tx: ManagedTransaction,
    input: { limit: number; maxAttempts: number; now?: Date },
  ): Promise<KnowledgeAttachment[]> {
    const result = await tx.run(
      `MATCH (a:KnowledgeAttachment)
       WHERE a.extractionStatus = 'pending'
         AND coalesce(a.extractionAttempts, 0) < $maxAttempts
         AND (a.extractionNextAttemptAt IS NULL OR a.extractionNextAttemptAt <= datetime($now))
       RETURN a {.*} AS a
       ORDER BY a.createdAt ASC
       LIMIT toInteger($limit)`,
      {
        limit: input.limit,
        maxAttempts: input.maxAttempts,
        now: dateParam(input.now ?? new Date()),
      },
    );
    return result.records.map((r) => toKnowledgeAttachment(r.get('a')));
  },

  // Outstanding extraction work, for /health. Ignores the backoff: an operator
  // wants the total still owed, not the subset due this instant.
  async countPendingExtraction(tx: ManagedTransaction, maxAttempts: number): Promise<number> {
    const result = await tx.run(
      `MATCH (a:KnowledgeAttachment)
       WHERE a.extractionStatus = 'pending' AND coalesce(a.extractionAttempts, 0) < $maxAttempts
       RETURN count(a) AS n`,
      { maxAttempts },
    );
    return Number(result.records[0]?.get('n') ?? 0);
  },

  // Attachments that will not be retried and now need the backfill. Counting
  // spent attempts as well as the 'failed' status covers the row that is still
  // 'pending' because maxAttempts was *lowered* after it failed: the claim
  // query already refuses it, so without this it would be owed by nobody and
  // reported by nothing.
  async countDeadLetteredExtraction(tx: ManagedTransaction, maxAttempts: number): Promise<number> {
    const result = await tx.run(
      `MATCH (a:KnowledgeAttachment)
       WHERE a.extractionStatus = 'failed'
          OR (a.extractionStatus = 'pending' AND coalesce(a.extractionAttempts, 0) >= $maxAttempts)
       RETURN count(a) AS n`,
      { maxAttempts },
    );
    return Number(result.records[0]?.get('n') ?? 0);
  },

  // Stamp a failed attempt. `nextAttemptAt` null means the attempts are spent,
  // so the row is dead-lettered to 'failed' and only the backfill will pick it
  // up again; otherwise it stays 'pending' and comes back when it is due.
  // Mirrors EpisodeRepository.recordDreamFailure.
  async recordExtractionFailure(
    tx: ManagedTransaction,
    input: { id: string; nextAttemptAt: Date | null; error: string },
  ): Promise<number> {
    const result = await tx.run(
      `MATCH (a:KnowledgeAttachment {id: $id})
       SET a.extractionAttempts = coalesce(a.extractionAttempts, 0) + 1,
           a.detail = $error,
           a.extractionNextAttemptAt = CASE
             WHEN $nextAttemptAt IS NULL THEN NULL ELSE datetime($nextAttemptAt) END,
           a.extractionStatus = CASE
             WHEN $nextAttemptAt IS NULL THEN 'failed' ELSE 'pending' END
       RETURN a.extractionAttempts AS attempts`,
      {
        id: input.id,
        error: input.error.slice(0, 500),
        nextAttemptAt: nullableDateParam(input.nextAttemptAt),
      },
    );
    return Number(result.records[0]?.get('attempts') ?? 0);
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
