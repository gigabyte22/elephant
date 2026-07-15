import type { ManagedTransaction } from 'neo4j-driver';
import type { KnowledgeDocument } from '../models/types.ts';
import { dateParam, nullableDateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import {
  type RetrievalScope,
  memoryItemParams,
  memoryItemSetClause,
  readScope,
  scopeWhereClause,
} from './scope.ts';

function toKnowledgeDocument(node: Record<string, unknown>): KnowledgeDocument {
  return {
    id: node.id as string,
    title: node.title as string,
    source: node.source as string,
    sourceUri: (node.sourceUri as string | undefined) ?? undefined,
    content: (node.content as string | undefined) ?? undefined,
    contentHash: (node.contentHash as string | undefined) ?? undefined,
    summary: node.summary as string,
    embedding: (node.embedding as number[]) ?? [],
    tags: (node.tags as string[]) ?? [],
    expiresAt: toJsDateOrNull(node.expiresAt),
    createdAt: toJsDate(node.createdAt),
    updatedAt: toJsDate(node.updatedAt),
    ...readScope(node),
  };
}

export const KnowledgeDocumentRepository = {
  async create(tx: ManagedTransaction, doc: KnowledgeDocument): Promise<KnowledgeDocument> {
    const result = await tx.run(
      `MERGE (d:KnowledgeDocument {id: $id})
       SET ${memoryItemSetClause('d')},
           d.title = $title,
           d.source = $source,
           d.sourceUri = $sourceUri,
           d.content = $content,
           d.contentHash = $contentHash,
           d.summary = $summary,
           d.embedding = $embedding,
           d.tags = $tags,
           d.expiresAt = CASE WHEN $expiresAt IS NULL THEN NULL ELSE datetime($expiresAt) END,
           d.createdAt = datetime($createdAt),
           d.updatedAt = datetime($updatedAt)
       RETURN d {.*} AS d`,
      {
        id: doc.id,
        title: doc.title,
        source: doc.source,
        sourceUri: doc.sourceUri ?? null,
        content: doc.content ?? null,
        contentHash: doc.contentHash ?? null,
        summary: doc.summary,
        embedding: doc.embedding,
        tags: doc.tags,
        expiresAt: nullableDateParam(doc.expiresAt ?? null),
        createdAt: dateParam(doc.createdAt),
        updatedAt: dateParam(doc.updatedAt),
        ...memoryItemParams('knowledge_document', doc),
      },
    );
    return toKnowledgeDocument(result.records[0]!.get('d'));
  },

  async update(
    tx: ManagedTransaction,
    id: string,
    input: {
      title?: string;
      content?: string;
      summary?: string;
      embedding?: number[];
      contentHash?: string;
      tags?: string[];
      expiresAt?: Date | null;
      updatedAt: Date;
    },
  ): Promise<KnowledgeDocument | null> {
    const sets: string[] = ['d.updatedAt = datetime($updatedAt)'];
    const params: Record<string, unknown> = {
      id,
      updatedAt: dateParam(input.updatedAt),
    };
    if (input.title !== undefined) {
      sets.push('d.title = $title');
      params.title = input.title;
    }
    if (input.content !== undefined) {
      sets.push('d.content = $content');
      params.content = input.content;
    }
    if (input.summary !== undefined) {
      sets.push('d.summary = $summary');
      params.summary = input.summary;
    }
    if (input.contentHash !== undefined) {
      sets.push('d.contentHash = $contentHash');
      params.contentHash = input.contentHash;
    }
    if (input.embedding !== undefined) {
      sets.push('d.embedding = $embedding');
      params.embedding = input.embedding;
    }
    if (input.tags !== undefined) {
      sets.push('d.tags = $tags');
      params.tags = input.tags;
    }
    if (input.expiresAt !== undefined) {
      sets.push(
        'd.expiresAt = CASE WHEN $expiresAt IS NULL THEN NULL ELSE datetime($expiresAt) END',
      );
      params.expiresAt = nullableDateParam(input.expiresAt);
    }
    const result = await tx.run(
      `MATCH (d:KnowledgeDocument {id: $id})
       SET ${sets.join(', ')}
       RETURN d {.*} AS d`,
      params,
    );
    const row = result.records[0];
    return row ? toKnowledgeDocument(row.get('d')) : null;
  },

  async get(tx: ManagedTransaction, id: string): Promise<KnowledgeDocument | null> {
    const result = await tx.run('MATCH (d:KnowledgeDocument {id: $id}) RETURN d {.*} AS d', { id });
    const row = result.records[0];
    return row ? toKnowledgeDocument(row.get('d')) : null;
  },

  async list(
    tx: ManagedTransaction,
    input: { scope?: RetrievalScope; limit?: number },
  ): Promise<KnowledgeDocument[]> {
    const limit = input.limit ?? 50;
    const { clause, params } = scopeWhereClause('d', input.scope);
    // Exclude soft-deleted / expired documents (expiresAt set to a past instant).
    const liveCondition = 'd.expiresAt IS NULL OR d.expiresAt > datetime()';
    const liveClause = clause ? `${clause} AND (${liveCondition})` : `WHERE ${liveCondition}`;
    const result = await tx.run(
      `MATCH (d:KnowledgeDocument)
       ${liveClause}
       RETURN d {.*} AS d
       ORDER BY d.updatedAt DESC
       LIMIT toInteger($limit)`,
      { ...params, limit },
    );
    return result.records.map((r) => toKnowledgeDocument(r.get('d')));
  },

  async softDelete(tx: ManagedTransaction, id: string, at: Date): Promise<void> {
    await tx.run(
      `MATCH (d:KnowledgeDocument {id: $id})
       SET d.expiresAt = datetime($at)`,
      { id, at: dateParam(at) },
    );
  },
};
