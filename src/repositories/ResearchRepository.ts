import type { ManagedTransaction } from 'neo4j-driver';
import type { Research } from '../models/types.ts';
import { dateParam, nullableDateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import {
  type RetrievalScope,
  memoryItemParams,
  memoryItemSetClause,
  readScope,
  scopeAndClause,
  scopeWhereClause,
} from './scope.ts';

function toResearch(node: Record<string, unknown>): Research {
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
    projectId: node.projectId as string,
    ...readScope(node), // overrides projectId with the same value, picks up userId
  };
}

export const ResearchRepository = {
  async create(tx: ManagedTransaction, research: Research): Promise<Research> {
    if (!research.projectId) {
      throw new Error('Research items require projectId');
    }
    const result = await tx.run(
      `MERGE (r:Research {id: $id})
       SET ${memoryItemSetClause('r')},
           r.title = $title,
           r.source = $source,
           r.sourceUri = $sourceUri,
           r.content = $content,
           r.contentHash = $contentHash,
           r.summary = $summary,
           r.embedding = $embedding,
           r.tags = $tags,
           r.expiresAt = CASE WHEN $expiresAt IS NULL THEN NULL ELSE datetime($expiresAt) END,
           r.createdAt = datetime($createdAt),
           r.updatedAt = datetime($updatedAt)
       RETURN r {.*} AS r`,
      {
        id: research.id,
        title: research.title,
        source: research.source,
        sourceUri: research.sourceUri ?? null,
        content: research.content ?? null,
        contentHash: research.contentHash ?? null,
        summary: research.summary,
        embedding: research.embedding,
        tags: research.tags,
        expiresAt: nullableDateParam(research.expiresAt ?? null),
        createdAt: dateParam(research.createdAt),
        updatedAt: dateParam(research.updatedAt),
        ...memoryItemParams('research', research),
      },
    );
    return toResearch(result.records[0]!.get('r'));
  },

  async get(tx: ManagedTransaction, id: string): Promise<Research | null> {
    const result = await tx.run('MATCH (r:Research {id: $id}) RETURN r {.*} AS r', { id });
    const row = result.records[0];
    return row ? toResearch(row.get('r')) : null;
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
      sourceUri?: string;
      expiresAt?: Date | null;
      updatedAt: Date;
    },
  ): Promise<Research | null> {
    const sets: string[] = ['r.updatedAt = datetime($updatedAt)'];
    const params: Record<string, unknown> = {
      id,
      updatedAt: dateParam(input.updatedAt),
    };
    if (input.title !== undefined) {
      sets.push('r.title = $title');
      params.title = input.title;
    }
    if (input.content !== undefined) {
      sets.push('r.content = $content');
      params.content = input.content;
    }
    if (input.summary !== undefined) {
      sets.push('r.summary = $summary');
      params.summary = input.summary;
    }
    if (input.contentHash !== undefined) {
      sets.push('r.contentHash = $contentHash');
      params.contentHash = input.contentHash;
    }
    if (input.embedding !== undefined) {
      sets.push('r.embedding = $embedding');
      params.embedding = input.embedding;
    }
    if (input.tags !== undefined) {
      sets.push('r.tags = $tags');
      params.tags = input.tags;
    }
    if (input.sourceUri !== undefined) {
      sets.push('r.sourceUri = $sourceUri');
      params.sourceUri = input.sourceUri;
    }
    if (input.expiresAt !== undefined) {
      sets.push(
        'r.expiresAt = CASE WHEN $expiresAt IS NULL THEN NULL ELSE datetime($expiresAt) END',
      );
      params.expiresAt = nullableDateParam(input.expiresAt);
    }
    const result = await tx.run(
      `MATCH (r:Research {id: $id})
       SET ${sets.join(', ')}
       RETURN r {.*} AS r`,
      params,
    );
    const row = result.records[0];
    return row ? toResearch(row.get('r')) : null;
  },

  async list(
    tx: ManagedTransaction,
    input: { scope?: RetrievalScope; limit?: number },
  ): Promise<Research[]> {
    const limit = input.limit ?? 50;
    const { clause, params } = scopeWhereClause('r', input.scope);
    // Research is the EXPIRABLE tier — that property is the whole reason it is
    // delegable to sub-agents. Without this predicate nothing ever expires on
    // read, and because softDelete is implemented as "set expiresAt = now",
    // deleted records kept coming straight back in the next list (2026-07-20).
    const live = 'r.expiresAt IS NULL OR r.expiresAt > datetime()';
    const where = clause ? `${clause} AND (${live})` : `WHERE ${live}`;
    const result = await tx.run(
      `MATCH (r:Research)
       ${where}
       RETURN r {.*} AS r
       ORDER BY r.updatedAt DESC
       LIMIT toInteger($limit)`,
      { ...params, limit },
    );
    return result.records.map((rec) => toResearch(rec.get('r')));
  },

  async listSimilar(
    tx: ManagedTransaction,
    input: {
      embedding: number[];
      limit: number;
      minScore?: number;
      scope?: RetrievalScope;
    },
  ): Promise<Array<Research & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const { clause, params } = scopeAndClause('node', input.scope);
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('research_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore ${clause}
       RETURN node {.*} AS r, score
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore, ...params },
    );
    return result.records.map((rec) => ({
      ...toResearch(rec.get('r')),
      score: rec.get('score') as number,
    }));
  },

  async softDelete(tx: ManagedTransaction, id: string, at: Date): Promise<void> {
    await tx.run(
      `MATCH (r:Research {id: $id})
       SET r.expiresAt = datetime($at)`,
      { id, at: dateParam(at) },
    );
  },
};
