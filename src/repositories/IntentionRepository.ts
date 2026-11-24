import type { ManagedTransaction } from 'neo4j-driver';
import type { Intention, IntentionStatus } from '../models/types.ts';
import { newId } from '../utils/ids.ts';
import { dateParam, nullableDateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import {
  memoryItemParams,
  memoryItemSetClause,
  type RetrievalScope,
  readScope,
  scopeAndClause,
  scopeWhereClause,
} from './scope.ts';

function toIntention(node: Record<string, unknown>): Intention {
  return {
    id: node.id as string,
    content: node.content as string,
    status: node.status as IntentionStatus,
    dueAt: toJsDateOrNull(node.dueAt),
    triggerHint: (node.triggerHint as string | null) ?? null,
    recurring: (node.recurring as boolean) ?? false,
    schedule: (node.schedule as string | null) ?? null,
    fireCount: (node.fireCount as number) ?? 0,
    lastFiredAt: toJsDateOrNull(node.lastFiredAt),
    validFrom: toJsDate(node.validFrom),
    validTo: toJsDateOrNull(node.validTo),
    createdAt: toJsDate(node.createdAt),
    completedAt: toJsDateOrNull(node.completedAt),
    embedding: (node.embedding as number[]) ?? [],
    importance: (node.importance as number) ?? 0.5,
    ...((node.agentId as string | undefined) ? { agentId: node.agentId as string } : {}),
    ...((node.sessionId as string | undefined) ? { sessionId: node.sessionId as string } : {}),
    ...((node.sourceEpisodeId as string | undefined)
      ? { sourceEpisodeId: node.sourceEpisodeId as string }
      : {}),
    ...((node.sourceFactId as string | undefined)
      ? { sourceFactId: node.sourceFactId as string }
      : {}),
    ...readScope(node),
  };
}

export const IntentionRepository = {
  async create(tx: ManagedTransaction, intention: Intention): Promise<Intention> {
    const result = await tx.run(
      `MERGE (i:Intention {id: $id})
       SET ${memoryItemSetClause('i')},
           i.content = $content,
           i.status = $status,
           i.dueAt = CASE WHEN $dueAt IS NULL THEN NULL ELSE datetime($dueAt) END,
           i.triggerHint = $triggerHint,
           i.recurring = $recurring,
           i.schedule = $schedule,
           i.fireCount = $fireCount,
           i.lastFiredAt = CASE WHEN $lastFiredAt IS NULL THEN NULL ELSE datetime($lastFiredAt) END,
           i.validFrom = datetime($validFrom),
           i.validTo = CASE WHEN $validTo IS NULL THEN NULL ELSE datetime($validTo) END,
           i.createdAt = datetime($createdAt),
           i.completedAt = CASE WHEN $completedAt IS NULL THEN NULL ELSE datetime($completedAt) END,
           i.embedding = $embedding,
           i.importance = $importance,
           i.agentId = $agentId,
           i.sessionId = $sessionId,
           i.sourceEpisodeId = $sourceEpisodeId,
           i.sourceFactId = $sourceFactId
       RETURN i {.*} AS i`,
      {
        id: intention.id,
        content: intention.content,
        status: intention.status,
        dueAt: nullableDateParam(intention.dueAt),
        triggerHint: intention.triggerHint,
        recurring: intention.recurring,
        schedule: intention.schedule,
        fireCount: intention.fireCount,
        lastFiredAt: nullableDateParam(intention.lastFiredAt),
        validFrom: dateParam(intention.validFrom),
        validTo: nullableDateParam(intention.validTo),
        createdAt: dateParam(intention.createdAt),
        completedAt: nullableDateParam(intention.completedAt),
        embedding: intention.embedding,
        importance: intention.importance,
        agentId: intention.agentId ?? null,
        sessionId: intention.sessionId ?? null,
        sourceEpisodeId: intention.sourceEpisodeId ?? null,
        sourceFactId: intention.sourceFactId ?? null,
        ...memoryItemParams('intention', intention),
      },
    );

    if (intention.sourceEpisodeId) {
      await tx.run(
        `MATCH (i:Intention {id: $intentionId}), (src:Episode {id: $episodeId})
         MERGE (src)-[:CONTAINS]->(i)`,
        { intentionId: intention.id, episodeId: intention.sourceEpisodeId },
      );
    }

    if (intention.sourceFactId) {
      await tx.run(
        `MATCH (i:Intention {id: $intentionId}), (f:Fact {id: $factId})
         MERGE (f)-[:MOTIVATES]->(i)`,
        { intentionId: intention.id, factId: intention.sourceFactId },
      );
    }

    return toIntention(result.records[0]!.get('i'));
  },

  async get(tx: ManagedTransaction, id: string): Promise<Intention | null> {
    const result = await tx.run('MATCH (i:Intention {id: $id}) RETURN i {.*} AS i', { id });
    const row = result.records[0];
    return row ? toIntention(row.get('i')) : null;
  },

  async list(
    tx: ManagedTransaction,
    input: { scope?: RetrievalScope; status?: IntentionStatus; limit?: number },
  ): Promise<Intention[]> {
    const limit = input.limit ?? 50;
    const { clause, params } = scopeWhereClause('i', input.scope);
    let statusClause = clause;
    if (input.status) {
      statusClause = clause ? `${clause} AND i.status = $status` : 'WHERE i.status = $status';
    }
    const result = await tx.run(
      `MATCH (i:Intention)
       ${statusClause}
       RETURN i {.*} AS i
       ORDER BY i.createdAt DESC, i.id DESC
       LIMIT toInteger($limit)`,
      { ...params, status: input.status ?? null, limit },
    );
    return result.records.map((r) => toIntention(r.get('i')));
  },

  // The one capability WorkingState lacks: index-backed "what is due?" query.
  // Used for boot-time reconciliation / "list my open commitments" — NOT a
  // continuous poll loop (firing stays in the orchestrator's clock).
  // Trigger-only intentions (dueAt IS NULL) never surface here by design.
  async listDue(
    tx: ManagedTransaction,
    input: {
      scope?: RetrievalScope;
      dueBefore: Date;
      status?: IntentionStatus;
      limit?: number;
    },
  ): Promise<Intention[]> {
    const status = input.status ?? 'pending';
    const limit = input.limit ?? 100;
    const { clause, params } = scopeAndClause('i', input.scope);
    const result = await tx.run(
      `MATCH (i:Intention)
       WHERE i.status = $status
         AND i.dueAt IS NOT NULL
         AND i.dueAt <= datetime($dueBefore)
         ${clause}
       RETURN i {.*} AS i
       ORDER BY i.dueAt ASC, i.id ASC
       LIMIT toInteger($limit)`,
      { status, dueBefore: dateParam(input.dueBefore), limit, ...params },
    );
    return result.records.map((r) => toIntention(r.get('i')));
  },

  // Idempotent terminal transition. Sets validTo (bi-temporal "no longer
  // current") and, when completing, completedAt. Returns the updated node or
  // null when the id no longer exists (guards a concurrent delete).
  async markStatus(
    tx: ManagedTransaction,
    input: { id: string; status: IntentionStatus; at: Date },
  ): Promise<Intention | null> {
    const result = await tx.run(
      `MATCH (i:Intention {id: $id})
       SET i.status = $status,
           i.validTo = datetime($at),
           i.completedAt = CASE WHEN $status = 'completed' THEN datetime($at) ELSE i.completedAt END
       RETURN i {.*} AS i`,
      { id: input.id, status: input.status, at: dateParam(input.at) },
    );
    const row = result.records[0];
    return row ? toIntention(row.get('i')) : null;
  },

  // Records a recurring fire: bumps fireCount and stamps lastFiredAt. The
  // intention stays 'pending' (recurring intentions never self-complete). The
  // durable per-fire audit event is emitted by the service. Returns the updated
  // node or null when the id no longer exists.
  async markFired(
    tx: ManagedTransaction,
    input: { id: string; at: Date },
  ): Promise<Intention | null> {
    const result = await tx.run(
      `MATCH (i:Intention {id: $id})
       SET i.fireCount = coalesce(i.fireCount, 0) + 1,
           i.lastFiredAt = datetime($at)
       RETURN i {.*} AS i`,
      { id: input.id, at: dateParam(input.at) },
    );
    const row = result.records[0];
    return row ? toIntention(row.get('i')) : null;
  },

  // Vector recall over open commitments only (status = 'pending'). Surfaces in
  // /recall when includeIntentions is set; mirrors ProcedureRepository.listSimilar.
  async listSimilar(
    tx: ManagedTransaction,
    input: { embedding: number[]; limit: number; minScore?: number; scope?: RetrievalScope },
  ): Promise<Array<Intention & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const { clause, params } = scopeAndClause('node', input.scope);
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('intention_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore AND node.status = 'pending' ${clause}
       RETURN node {.*} AS i, score
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore, ...params },
    );
    return result.records.map((r) => ({
      ...toIntention(r.get('i')),
      score: r.get('score') as number,
    }));
  },

  // Flip hard-overdue one-time pending intentions to 'expired', and append one
  // :AuditEvent per flipped intention in the same transaction (the other
  // terminal transitions, complete/cancel, are audited too). Run hourly by
  // src/jobs/IntentionReaper.ts; mirrors ObservationReaper but transitions
  // status instead of deleting.
  //
  // Recurring intentions are never expired: their `dueAt` is the first fire
  // time and markFired does not advance it, so a live recurring commitment
  // looks "overdue" forever. Only the orchestrator can retire one (cancel).
  //
  // Two statements, not one per row: the first picks the batch, the second
  // re-checks each row (a concurrent complete/cancel wins) and writes the
  // status and the event together. Event ids are minted here so they stay
  // UUIDv7 like every other id; `at` is shared by the batch, so the id is what
  // orders a batch's events (see AuditEventRepository's tie-break).
  async reapExpired(
    tx: ManagedTransaction,
    input: { now: Date; graceDays?: number; limit?: number; actor?: string },
  ): Promise<number> {
    const graceDays = input.graceDays ?? 7;
    const limit = input.limit ?? 5000;
    const now = dateParam(input.now);
    const due = await tx.run(
      `MATCH (i:Intention)
       WHERE i.status = 'pending'
         AND coalesce(i.recurring, false) = false
         AND i.dueAt IS NOT NULL
         AND i.dueAt <= datetime($now) - duration({days: $graceDays})
       RETURN i.id AS id
       ORDER BY i.dueAt ASC, i.id ASC
       LIMIT toInteger($limit)`,
      { now, graceDays, limit },
    );
    if (due.records.length === 0) return 0;
    const rows = due.records.map((r) => ({ id: r.get('id') as string, eventId: newId() }));
    const result = await tx.run(
      `UNWIND $rows AS row
       MATCH (i:Intention {id: row.id})
       WHERE i.status = 'pending'
       SET i.status = 'expired', i.validTo = datetime($now)
       CREATE (:AuditEvent {
         id: row.eventId,
         kind: 'update',
         targetId: i.id,
         targetKind: 'intention',
         payload: $payload,
         at: datetime($now),
         actor: $actor
       })
       RETURN count(*) AS expired`,
      {
        rows,
        now,
        actor: input.actor ?? null,
        payload: JSON.stringify({
          reason: 'expired',
          transition: 'pending->expired',
          graceDays,
        }),
      },
    );
    return (result.records[0]?.get('expired') as number) ?? 0;
  },
};
