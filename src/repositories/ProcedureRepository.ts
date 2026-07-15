import type { ManagedTransaction } from 'neo4j-driver';
import type { Procedure } from '../models/types.ts';
import { dateParam, nullableDateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import {
  type RetrievalScope,
  memoryItemParams,
  memoryItemSetClause,
  readScope,
  scopeAndClause,
  scopeWhereClause,
} from './scope.ts';

function toProcedure(node: Record<string, unknown>): Procedure {
  return {
    id: node.id as string,
    name: node.name as string,
    version: (node.version as number) ?? 1,
    content: node.content as string,
    whenToUse: node.whenToUse as string,
    embedding: (node.embedding as number[]) ?? [],
    successRate: (node.successRate as number) ?? 0.5,
    invocationCount: (node.invocationCount as number) ?? 0,
    lastSuccessAt: toJsDateOrNull(node.lastSuccessAt),
    expiresAt: toJsDateOrNull(node.expiresAt),
    createdAt: toJsDate(node.createdAt),
    updatedAt: toJsDate(node.updatedAt),
    ...readScope(node),
  };
}

export const ProcedureRepository = {
  async create(tx: ManagedTransaction, proc: Procedure): Promise<Procedure> {
    const result = await tx.run(
      `MERGE (p:Procedure {id: $id})
       SET ${memoryItemSetClause('p')},
           p.name = $name,
           p.version = $version,
           p.content = $content,
           p.whenToUse = $whenToUse,
           p.embedding = $embedding,
           p.successRate = $successRate,
           p.invocationCount = $invocationCount,
           p.lastSuccessAt = CASE WHEN $lastSuccessAt IS NULL THEN NULL ELSE datetime($lastSuccessAt) END,
           p.expiresAt = CASE WHEN $expiresAt IS NULL THEN NULL ELSE datetime($expiresAt) END,
           p.createdAt = datetime($createdAt),
           p.updatedAt = datetime($updatedAt)
       RETURN p {.*} AS p`,
      {
        id: proc.id,
        name: proc.name,
        version: proc.version,
        content: proc.content,
        whenToUse: proc.whenToUse,
        embedding: proc.embedding,
        successRate: proc.successRate,
        invocationCount: proc.invocationCount,
        lastSuccessAt: nullableDateParam(proc.lastSuccessAt ?? null),
        expiresAt: nullableDateParam(proc.expiresAt ?? null),
        createdAt: dateParam(proc.createdAt),
        updatedAt: dateParam(proc.updatedAt),
        ...memoryItemParams('procedure', proc),
      },
    );
    return toProcedure(result.records[0]!.get('p'));
  },

  async update(
    tx: ManagedTransaction,
    id: string,
    input: {
      name?: string;
      content?: string;
      whenToUse?: string;
      embedding?: number[];
      version?: number;
      successRate?: number;
      invocationCount?: number;
      lastSuccessAt?: Date | null;
      expiresAt?: Date | null;
      updatedAt: Date;
    },
  ): Promise<Procedure | null> {
    const sets: string[] = ['p.updatedAt = datetime($updatedAt)'];
    const params: Record<string, unknown> = { id, updatedAt: dateParam(input.updatedAt) };

    if (input.name !== undefined) {
      sets.push('p.name = $name');
      params.name = input.name;
    }
    if (input.content !== undefined) {
      sets.push('p.content = $content');
      params.content = input.content;
    }
    if (input.whenToUse !== undefined) {
      sets.push('p.whenToUse = $whenToUse');
      params.whenToUse = input.whenToUse;
    }
    if (input.embedding !== undefined) {
      sets.push('p.embedding = $embedding');
      params.embedding = input.embedding;
    }
    if (input.version !== undefined) {
      sets.push('p.version = $version');
      params.version = input.version;
    }
    if (input.successRate !== undefined) {
      sets.push('p.successRate = $successRate');
      params.successRate = input.successRate;
    }
    if (input.invocationCount !== undefined) {
      sets.push('p.invocationCount = $invocationCount');
      params.invocationCount = input.invocationCount;
    }
    if (input.lastSuccessAt !== undefined) {
      sets.push(
        'p.lastSuccessAt = CASE WHEN $lastSuccessAt IS NULL THEN NULL ELSE datetime($lastSuccessAt) END',
      );
      params.lastSuccessAt = nullableDateParam(input.lastSuccessAt);
    }
    if (input.expiresAt !== undefined) {
      sets.push(
        'p.expiresAt = CASE WHEN $expiresAt IS NULL THEN NULL ELSE datetime($expiresAt) END',
      );
      params.expiresAt = nullableDateParam(input.expiresAt);
    }

    const result = await tx.run(
      `MATCH (p:Procedure {id: $id})
       SET ${sets.join(', ')}
       RETURN p {.*} AS p`,
      params,
    );
    const row = result.records[0];
    return row ? toProcedure(row.get('p')) : null;
  },

  async get(tx: ManagedTransaction, id: string): Promise<Procedure | null> {
    const result = await tx.run('MATCH (p:Procedure {id: $id}) RETURN p {.*} AS p', { id });
    const row = result.records[0];
    return row ? toProcedure(row.get('p')) : null;
  },

  async getByName(
    tx: ManagedTransaction,
    input: { name: string; projectId?: string | null },
  ): Promise<Procedure | null> {
    const result = await tx.run(
      `MATCH (p:Procedure {name: $name})
       WHERE coalesce(p.projectId, '') = coalesce($projectId, '')
       RETURN p {.*} AS p
       ORDER BY p.version DESC
       LIMIT 1`,
      { name: input.name, projectId: input.projectId ?? null },
    );
    const row = result.records[0];
    return row ? toProcedure(row.get('p')) : null;
  },

  async list(
    tx: ManagedTransaction,
    input: { scope?: RetrievalScope; limit?: number },
  ): Promise<Procedure[]> {
    const limit = input.limit ?? 50;
    const { clause, params } = scopeWhereClause('p', input.scope);
    const result = await tx.run(
      `MATCH (p:Procedure)
       ${clause}
       RETURN p {.*} AS p
       ORDER BY p.updatedAt DESC
       LIMIT toInteger($limit)`,
      { ...params, limit },
    );
    return result.records.map((r) => toProcedure(r.get('p')));
  },

  async listSimilar(
    tx: ManagedTransaction,
    input: {
      embedding: number[];
      limit: number;
      minScore?: number;
      scope?: RetrievalScope;
    },
  ): Promise<Array<Procedure & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const { clause, params } = scopeAndClause('node', input.scope);
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('procedure_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore ${clause}
       RETURN node {.*} AS p, score
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore, ...params },
    );
    return result.records.map((r) => ({
      ...toProcedure(r.get('p')),
      score: r.get('score') as number,
    }));
  },

  async fullTextSearch(
    tx: ManagedTransaction,
    input: { query: string; limit: number; scope?: RetrievalScope },
  ): Promise<Array<Procedure & { score: number }>> {
    const { clause, params } = scopeAndClause('node', input.scope);
    const result = await tx.run(
      `CALL db.index.fulltext.queryNodes('procedure_fulltext', $q) YIELD node, score
       WHERE node:Procedure ${clause}
       RETURN node {.*} AS p, score
       ORDER BY score DESC
       LIMIT toInteger($limit)`,
      { q: input.query, limit: input.limit, ...params },
    );
    return result.records.map((r) => ({
      ...toProcedure(r.get('p')),
      score: r.get('score') as number,
    }));
  },

  async supersede(
    tx: ManagedTransaction,
    input: { oldId: string; newId: string; reason: string; at: Date },
  ): Promise<void> {
    await tx.run(
      `MATCH (oldP:Procedure {id: $oldId}), (newP:Procedure {id: $newId})
       MERGE (newP)-[r:SUPERSEDES]->(oldP)
       SET r.reason = $reason, r.supersededAt = datetime($at)`,
      { oldId: input.oldId, newId: input.newId, reason: input.reason, at: dateParam(input.at) },
    );
  },

  async softDelete(tx: ManagedTransaction, id: string, at: Date): Promise<void> {
    await tx.run(
      `MATCH (p:Procedure {id: $id})
       SET p.expiresAt = datetime($at)`,
      { id, at: dateParam(at) },
    );
  },
};
