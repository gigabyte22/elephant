// CRUD + lifecycle for Intention (prospective memory) items. Elephant stores
// and audits intentions; it does NOT fire them — the orchestrator owns the
// clock and calls complete()/cancel() back. Terminal transitions snapshot the
// prior state via AuditService.revise() (the same archive machinery
// ProcedureService.update uses) so the full history is reconstructable.

import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import { read, write } from '../config/neo4j.ts';
import { badRequest, notFound } from '../http/errors.ts';
import type { Intention, IntentionStatus, Scope } from '../models/types.ts';
import { IntentionRepository } from '../repositories/IntentionRepository.ts';
import type { RetrievalScope } from '../repositories/scope.ts';
import { newId } from '../utils/ids.ts';
import { AuditService } from './AuditService.ts';

interface Deps {
  embedder: EmbeddingAdapter;
  config: { embedderMaxInputTokens?: number };
}

export interface IntentionScope extends Scope {
  agentId?: string;
  sessionId?: string;
}

export interface CreateIntentionInput {
  id?: string;
  content: string;
  dueAt?: Date | null;
  triggerHint?: string | null;
  recurring?: boolean;
  schedule?: string | null;
  importance?: number;
  scope?: IntentionScope;
  sourceEpisodeId?: string;
  sourceFactId?: string;
  actor?: string;
}

export interface ListIntentionsInput {
  scope?: RetrievalScope;
  status?: IntentionStatus;
  limit?: number;
}

export interface ListDueInput {
  scope?: RetrievalScope;
  before?: Date;
  status?: IntentionStatus;
  limit?: number;
}

export interface IntentionActionInput {
  actor?: string;
  reason?: string;
}

export function createIntentionService(deps: Deps) {
  const { embedder, config } = deps;
  const embedderLimit = Math.min(
    embedder.maxInputTokens,
    config.embedderMaxInputTokens ?? embedder.maxInputTokens,
  );

  async function ensureFits(text: string): Promise<void> {
    const tokens = await embedder.countTokens(text);
    if (tokens > embedderLimit) {
      throw badRequest(
        `intention content exceeds embedder limit of ${embedderLimit} tokens (got ~${tokens})`,
      );
    }
  }

  async function create(input: CreateIntentionInput): Promise<Intention> {
    const dueAt = input.dueAt ?? null;
    const triggerHint = input.triggerHint ?? null;
    const schedule = input.schedule ?? null;
    // An intention must be actionable: time-due-able (dueAt), schedule-driven
    // (recurring crons), or trigger-recallable (triggerHint).
    if (dueAt === null && triggerHint === null && schedule === null) {
      throw badRequest('intention requires at least one of dueAt, triggerHint, or schedule');
    }

    await ensureFits(input.content);
    const embedding = await embedder.embed(input.content);

    const now = new Date();
    const scope = input.scope ?? {};
    const intention: Intention = {
      id: input.id ?? newId(),
      content: input.content,
      status: 'pending',
      dueAt,
      triggerHint,
      recurring: input.recurring ?? false,
      schedule,
      fireCount: 0,
      lastFiredAt: null,
      validFrom: now,
      validTo: null,
      createdAt: now,
      completedAt: null,
      embedding,
      importance: input.importance ?? 0.5,
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.userId ? { userId: scope.userId } : {}),
      ...(input.sourceEpisodeId ? { sourceEpisodeId: input.sourceEpisodeId } : {}),
      ...(input.sourceFactId ? { sourceFactId: input.sourceFactId } : {}),
    };

    return write(async (tx) => {
      const created = await IntentionRepository.create(tx, intention);
      await AuditService.record({
        tx,
        kind: 'create',
        targetId: created.id,
        targetKind: 'intention',
        actor: input.actor,
        payload: {
          status: created.status,
          dueAt: created.dueAt ? created.dueAt.toISOString() : null,
          triggerHint: created.triggerHint,
          recurring: created.recurring,
          schedule: created.schedule,
        },
      });
      return created;
    });
  }

  async function get(id: string): Promise<Intention | null> {
    return read((tx) => IntentionRepository.get(tx, id));
  }

  async function list(input: ListIntentionsInput = {}): Promise<Intention[]> {
    return read((tx) => IntentionRepository.list(tx, input));
  }

  async function listDue(input: ListDueInput = {}): Promise<Intention[]> {
    const dueBefore = input.before ?? new Date();
    return read((tx) =>
      IntentionRepository.listDue(tx, {
        scope: input.scope,
        dueBefore,
        status: input.status ?? 'pending',
        limit: input.limit,
      }),
    );
  }

  // Auditable, idempotent terminal transition shared by complete/cancel.
  async function transition(
    id: string,
    target: 'completed' | 'cancelled',
    input: IntentionActionInput,
  ): Promise<Intention> {
    const before = await read((tx) => IntentionRepository.get(tx, id));
    if (!before) throw notFound(`intention ${id} not found`);

    // Idempotent: re-completing/cancelling an already-terminal intention in the
    // same state returns it unchanged, with no second audit event.
    if (before.status === target) return before;

    // `completed` is terminal — don't resurrect a finished commitment.
    if (before.status === 'completed') {
      throw badRequest(`intention ${id} is already completed and cannot be ${target}`);
    }

    const now = new Date();
    return write(async (tx) => {
      await AuditService.revise({
        tx,
        before,
        kind: 'intention',
        reason: input.reason ?? target,
        actor: input.actor,
        payload: { transition: `${before.status}->${target}` },
      });
      const updated = await IntentionRepository.markStatus(tx, { id, status: target, at: now });
      if (!updated) throw notFound(`intention ${id} disappeared during ${target}`);
      return updated;
    });
  }

  async function complete(id: string, input: IntentionActionInput = {}): Promise<Intention> {
    return transition(id, 'completed', input);
  }

  async function cancel(id: string, input: IntentionActionInput = {}): Promise<Intention> {
    return transition(id, 'cancelled', input);
  }

  // Records a recurring fire: bumps the durable fireCount/lastFiredAt and emits
  // an append-only audit event (no TTL) so each occurrence leaves a permanent,
  // queryable trail. The intention stays pending (recurring never self-completes).
  async function markFired(id: string, input: IntentionActionInput = {}): Promise<Intention> {
    const now = new Date();
    return write(async (tx) => {
      const updated = await IntentionRepository.markFired(tx, { id, at: now });
      if (!updated) throw notFound(`intention ${id} not found`);
      await AuditService.record({
        tx,
        kind: 'update',
        targetId: id,
        targetKind: 'intention',
        actor: input.actor,
        payload: { event: 'fired', fireCount: updated.fireCount, reason: input.reason },
      });
      return updated;
    });
  }

  async function reapExpired(now: Date = new Date()): Promise<number> {
    return write((tx) => IntentionRepository.reapExpired(tx, { now }));
  }

  return { create, get, list, listDue, complete, cancel, markFired, reapExpired };
}

export type IntentionService = ReturnType<typeof createIntentionService>;
