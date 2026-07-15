import type { ManagedTransaction } from 'neo4j-driver';
import type { ArchivedRevision, MemoryKind } from '../models/types.ts';
import { dateParam, toJsDate } from '../utils/neo4j-conv.ts';

function toArchivedRevision(node: Record<string, unknown>): ArchivedRevision {
  return {
    id: node.id as string,
    originalId: node.originalId as string,
    originalKind: node.originalKind as MemoryKind,
    snapshot: node.snapshot as string,
    archivedAt: toJsDate(node.archivedAt),
    reason: node.reason as string,
    archivedBy: (node.archivedBy as string | undefined) ?? undefined,
  };
}

export const ArchivedRevisionRepository = {
  async create(tx: ManagedTransaction, rev: ArchivedRevision): Promise<ArchivedRevision> {
    const result = await tx.run(
      `MERGE (a:ArchivedRevision {id: $id})
       SET a.originalId = $originalId,
           a.originalKind = $originalKind,
           a.snapshot = $snapshot,
           a.archivedAt = datetime($archivedAt),
           a.reason = $reason,
           a.archivedBy = $archivedBy
       WITH a
       OPTIONAL MATCH (live:MemoryItem {id: $originalId})
       FOREACH (_ IN CASE WHEN live IS NULL THEN [] ELSE [1] END |
         MERGE (live)-[:HAS_REVISION]->(a)
       )
       RETURN a {.*} AS a`,
      {
        id: rev.id,
        originalId: rev.originalId,
        originalKind: rev.originalKind,
        snapshot: rev.snapshot,
        archivedAt: dateParam(rev.archivedAt),
        reason: rev.reason,
        archivedBy: rev.archivedBy ?? null,
      },
    );
    return toArchivedRevision(result.records[0]!.get('a'));
  },

  async listForOriginal(
    tx: ManagedTransaction,
    input: { originalId: string; limit?: number },
  ): Promise<ArchivedRevision[]> {
    const result = await tx.run(
      `MATCH (a:ArchivedRevision {originalId: $originalId})
       RETURN a {.*} AS a
       ORDER BY a.archivedAt DESC
       LIMIT toInteger($limit)`,
      { originalId: input.originalId, limit: input.limit ?? 100 },
    );
    return result.records.map((r) => toArchivedRevision(r.get('a')));
  },
};
