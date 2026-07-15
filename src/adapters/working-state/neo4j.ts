// Neo4j-backed WorkingState adapter (default).
//
// :WorkingState nodes have a (scopeKey, key) composite uniqueness constraint
// (see migrate.ts). Values are JSON-serialised for backend portability —
// Neo4j supports arbitrary scalar/array properties natively, but encoding to
// JSON keeps shapes 1:1 with the Redis adapter.

import type { ManagedTransaction } from 'neo4j-driver';
import { read, write } from '../../config/neo4j.ts';
import type { WorkingStateEntry, WorkingStateScope } from '../../models/types.ts';
import { dateParam, toJsDate, toJsDateOrNull } from '../../utils/neo4j-conv.ts';
import { type WorkingStateAdapter, scopeKey } from './types.ts';

function rowToEntry(node: Record<string, unknown>, scope: WorkingStateScope): WorkingStateEntry {
  let value: unknown;
  try {
    value = JSON.parse(node.value as string);
  } catch {
    value = node.value;
  }
  return {
    scope,
    key: node.key as string,
    value,
    expiresAt: toJsDateOrNull(node.expiresAt),
    updatedAt: toJsDate(node.updatedAt),
  };
}

export class Neo4jWorkingStateAdapter implements WorkingStateAdapter {
  async set(scope: WorkingStateScope, key: string, value: unknown, ttlSec?: number): Promise<void> {
    const now = new Date();
    const expiresAt = ttlSec ? new Date(now.getTime() + ttlSec * 1000) : null;
    await write(async (tx: ManagedTransaction) => {
      await tx.run(
        `MERGE (w:WorkingState {scopeKey: $scopeKey, key: $key})
         SET w.value = $value,
             w.agentId = $agentId,
             w.sessionId = $sessionId,
             w.userId = $userId,
             w.projectId = $projectId,
             w.updatedAt = datetime($updatedAt),
             w.expiresAt = CASE WHEN $expiresAt IS NULL THEN NULL ELSE datetime($expiresAt) END`,
        {
          scopeKey: scopeKey(scope),
          key,
          value: JSON.stringify(value),
          agentId: scope.agentId,
          sessionId: scope.sessionId ?? null,
          userId: scope.userId ?? null,
          projectId: scope.projectId ?? null,
          updatedAt: dateParam(now),
          expiresAt: expiresAt ? dateParam(expiresAt) : null,
        },
      );
    });
  }

  async get(scope: WorkingStateScope, key: string): Promise<WorkingStateEntry | null> {
    return read(async (tx) => {
      const result = await tx.run(
        `MATCH (w:WorkingState {scopeKey: $scopeKey, key: $key})
         WHERE w.expiresAt IS NULL OR w.expiresAt > datetime()
         RETURN w {.*} AS w`,
        { scopeKey: scopeKey(scope), key },
      );
      const row = result.records[0];
      return row ? rowToEntry(row.get('w'), scope) : null;
    });
  }

  async delete(scope: WorkingStateScope, key: string): Promise<void> {
    await write(async (tx) => {
      await tx.run(
        `MATCH (w:WorkingState {scopeKey: $scopeKey, key: $key})
         DETACH DELETE w`,
        { scopeKey: scopeKey(scope), key },
      );
    });
  }

  async list(scope: WorkingStateScope, prefix?: string): Promise<WorkingStateEntry[]> {
    return read(async (tx) => {
      const result = await tx.run(
        `MATCH (w:WorkingState {scopeKey: $scopeKey})
         WHERE (w.expiresAt IS NULL OR w.expiresAt > datetime())
           AND ($prefix IS NULL OR w.key STARTS WITH $prefix)
         RETURN w {.*} AS w
         ORDER BY w.updatedAt DESC`,
        { scopeKey: scopeKey(scope), prefix: prefix ?? null },
      );
      return result.records.map((r) => rowToEntry(r.get('w'), scope));
    });
  }

  async reapExpired(now: Date): Promise<number> {
    return write(async (tx) => {
      const result = await tx.run(
        `MATCH (w:WorkingState)
         WHERE w.expiresAt IS NOT NULL AND w.expiresAt <= datetime($now)
         WITH w LIMIT 5000
         DETACH DELETE w
         RETURN count(*) AS deleted`,
        { now: dateParam(now) },
      );
      return (result.records[0]?.get('deleted') as number) ?? 0;
    });
  }
}
