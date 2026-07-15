import type { ManagedTransaction } from 'neo4j-driver';
import type { AuditEvent, AuditEventKind, MemoryKind } from '../models/types.ts';
import { dateParam, toJsDate } from '../utils/neo4j-conv.ts';

function toAuditEvent(node: Record<string, unknown>): AuditEvent {
  return {
    id: node.id as string,
    kind: node.kind as AuditEventKind,
    targetId: node.targetId as string,
    targetKind: node.targetKind as MemoryKind,
    payload: node.payload as string,
    at: toJsDate(node.at),
    actor: (node.actor as string | undefined) ?? undefined,
  };
}

export const AuditEventRepository = {
  async create(tx: ManagedTransaction, event: AuditEvent): Promise<AuditEvent> {
    const result = await tx.run(
      `MERGE (e:AuditEvent {id: $id})
       SET e.kind = $kind,
           e.targetId = $targetId,
           e.targetKind = $targetKind,
           e.payload = $payload,
           e.at = datetime($at),
           e.actor = $actor
       RETURN e {.*} AS e`,
      {
        id: event.id,
        kind: event.kind,
        targetId: event.targetId,
        targetKind: event.targetKind,
        payload: event.payload,
        at: dateParam(event.at),
        actor: event.actor ?? null,
      },
    );
    return toAuditEvent(result.records[0]!.get('e'));
  },

  async listForTarget(
    tx: ManagedTransaction,
    input: { targetId: string; limit?: number },
  ): Promise<AuditEvent[]> {
    const result = await tx.run(
      `MATCH (e:AuditEvent {targetId: $targetId})
       RETURN e {.*} AS e
       ORDER BY e.at DESC
       LIMIT toInteger($limit)`,
      { targetId: input.targetId, limit: input.limit ?? 100 },
    );
    return result.records.map((r) => toAuditEvent(r.get('e')));
  },

  async list(
    tx: ManagedTransaction,
    input: { actor?: string; kind?: AuditEventKind; from?: Date; to?: Date; limit?: number },
  ): Promise<AuditEvent[]> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = { limit: input.limit ?? 100 };
    if (input.actor) {
      conditions.push('e.actor = $actor');
      params.actor = input.actor;
    }
    if (input.kind) {
      conditions.push('e.kind = $kind');
      params.kind = input.kind;
    }
    if (input.from) {
      conditions.push('e.at >= datetime($from)');
      params.from = dateParam(input.from);
    }
    if (input.to) {
      conditions.push('e.at <= datetime($to)');
      params.to = dateParam(input.to);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await tx.run(
      `MATCH (e:AuditEvent)
       ${whereClause}
       RETURN e {.*} AS e
       ORDER BY e.at DESC
       LIMIT toInteger($limit)`,
      params,
    );
    return result.records.map((r) => toAuditEvent(r.get('e')));
  },
};
