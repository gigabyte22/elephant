// Append-only audit log + revision history for memory mutations.
//
// Two collaborating shapes:
//   - :ArchivedRevision — a JSON snapshot of a memory item's pre-update state,
//     linked to the live node via (:MemoryItem)-[:HAS_REVISION]->(:ArchivedRevision).
//   - :AuditEvent — one append-only event per mutation (create, update, supersede,
//     soft_delete, prune, promote, archive). Carries an arbitrary JSON payload.
//
// Together these answer "what did this memory look like at time T?" and "what
// happened to it, when, and why?" without requiring full bi-temporal queries.

import type { ManagedTransaction } from 'neo4j-driver';
import type { ArchivedRevision, AuditEvent, AuditEventKind, MemoryKind } from '../models/types.ts';
import { ArchivedRevisionRepository } from '../repositories/ArchivedRevisionRepository.ts';
import { AuditEventRepository } from '../repositories/AuditEventRepository.ts';
import { newId } from '../utils/ids.ts';

export interface ReviseInput<T> {
  tx: ManagedTransaction;
  before: T;
  kind: MemoryKind;
  reason: string;
  actor?: string;
  // Optional supplemental info — e.g. { changes: ['title','summary'] }.
  payload?: Record<string, unknown>;
  eventKind?: AuditEventKind; // defaults to 'update'
}

export interface AuditInput {
  tx: ManagedTransaction;
  kind: AuditEventKind;
  targetId: string;
  targetKind: MemoryKind;
  payload?: Record<string, unknown>;
  actor?: string;
}

export const AuditService = {
  /**
   * Snapshot a memory item before mutation and emit an audit event in one
   * call. Returns the created revision so callers can correlate.
   */
  async revise<T extends { id: string }>(input: ReviseInput<T>): Promise<ArchivedRevision> {
    const archivedAt = new Date();
    const revision: ArchivedRevision = {
      id: newId(),
      originalId: input.before.id,
      originalKind: input.kind,
      snapshot: JSON.stringify(serialiseForSnapshot(input.before)),
      archivedAt,
      reason: input.reason,
      archivedBy: input.actor,
    };
    await ArchivedRevisionRepository.create(input.tx, revision);

    await AuditService.record({
      tx: input.tx,
      kind: input.eventKind ?? 'update',
      targetId: input.before.id,
      targetKind: input.kind,
      actor: input.actor,
      payload: { reason: input.reason, revisionId: revision.id, ...input.payload },
    });

    return revision;
  },

  /**
   * Append a single audit event without a revision snapshot. Use for
   * lifecycle events that don't mutate node properties (promotion, prune,
   * supersede, soft-delete).
   */
  async record(input: AuditInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: newId(),
      kind: input.kind,
      targetId: input.targetId,
      targetKind: input.targetKind,
      payload: JSON.stringify(input.payload ?? {}),
      at: new Date(),
      actor: input.actor,
    };
    return AuditEventRepository.create(input.tx, event);
  },

  async revisionsFor(
    tx: ManagedTransaction,
    targetId: string,
    limit?: number,
  ): Promise<ArchivedRevision[]> {
    return ArchivedRevisionRepository.listForOriginal(tx, { originalId: targetId, limit });
  },

  async eventsFor(tx: ManagedTransaction, targetId: string, limit?: number): Promise<AuditEvent[]> {
    return AuditEventRepository.listForTarget(tx, { targetId, limit });
  },

  async listEvents(
    tx: ManagedTransaction,
    input: { actor?: string; kind?: AuditEventKind; from?: Date; to?: Date; limit?: number },
  ): Promise<AuditEvent[]> {
    return AuditEventRepository.list(tx, input);
  },
};

// Embeddings and dates need normalisation before JSON.stringify so the
// snapshot is human-readable on retrieval.
function serialiseForSnapshot(obj: unknown): unknown {
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(serialiseForSnapshot);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Strip embedding vectors — they're noisy and reproducible from content.
      if (key === 'embedding') continue;
      out[key] = serialiseForSnapshot(value);
    }
    return out;
  }
  return obj;
}
