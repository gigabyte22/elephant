// CRUD for Procedure (skill / workflow) memory items. Updates archive the
// prior state via AuditService.revise() and link new versions to old via
// :SUPERSEDES so retrieval and recall can audit how a procedure has evolved.

import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import { read, write } from '../config/neo4j.ts';
import { badRequest, notFound } from '../http/errors.ts';
import type { Procedure, Scope } from '../models/types.ts';
import { ProcedureRepository } from '../repositories/ProcedureRepository.ts';
import type { RetrievalScope } from '../repositories/scope.ts';
import { newId } from '../utils/ids.ts';
import { fitToTokenBudget } from '../utils/tokens.ts';
import { AuditService } from './AuditService.ts';

interface Deps {
  embedder: EmbeddingAdapter;
  config: { embedderMaxInputTokens?: number };
}

export interface CreateProcedureInput {
  id?: string;
  name: string;
  content: string;
  whenToUse: string;
  scope?: Scope;
  expiresAt?: Date | null;
  actor?: string;
}

export interface UpdateProcedureInput {
  content?: string;
  whenToUse?: string;
  successRate?: number;
  invocationCount?: number;
  lastSuccessAt?: Date | null;
  expiresAt?: Date | null;
  actor?: string;
  reason?: string;
}

const procedureEmbedText = (whenToUse: string, content: string) => `${whenToUse}\n\n${content}`;

export function createProcedureService(deps: Deps) {
  const { embedder, config } = deps;
  const embedderLimit = Math.min(
    embedder.maxInputTokens,
    config.embedderMaxInputTokens ?? embedder.maxInputTokens,
  );

  // whenToUse is the retrieval signal and is never truncated: if it alone
  // exceeds the limit the trigger description is genuinely broken → 400.
  // Otherwise embed whenToUse plus as much of content as fits the budget;
  // the full content is stored on the node unchanged. Fitting the combined
  // string (rather than budgeting the remainder) sidesteps tokenizer
  // non-additivity — the monotone prefix search always keeps whenToUse whole.
  async function buildEmbedText(name: string, whenToUse: string, content: string): Promise<string> {
    const whenTokens = await embedder.countTokens(whenToUse);
    if (whenTokens > embedderLimit) {
      throw badRequest(
        `procedure whenToUse exceeds embedder limit of ${embedderLimit} tokens (got ~${whenTokens})`,
      );
    }
    const full = procedureEmbedText(whenToUse, content);
    const fitted = await fitToTokenBudget(full, embedderLimit, (t) => embedder.countTokens(t));
    if (fitted !== full) {
      console.warn(
        `[procedures] "${name}": embed text truncated to ~${embedderLimit} tokens; full content stored`,
      );
    }
    return fitted;
  }

  async function create(input: CreateProcedureInput): Promise<Procedure> {
    const embedText = await buildEmbedText(input.name, input.whenToUse, input.content);
    const embedding = await embedder.embed(embedText);

    const now = new Date();
    const proc: Procedure = {
      id: input.id ?? newId(),
      name: input.name,
      version: 1,
      content: input.content,
      whenToUse: input.whenToUse,
      embedding,
      successRate: 0.5,
      invocationCount: 0,
      lastSuccessAt: null,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
      ...(input.scope ?? {}),
    };

    return write(async (tx) => {
      const created = await ProcedureRepository.create(tx, proc);
      await AuditService.record({
        tx,
        kind: 'create',
        targetId: created.id,
        targetKind: 'procedure',
        actor: input.actor,
        payload: { name: created.name, version: created.version },
      });
      return created;
    });
  }

  async function update(id: string, input: UpdateProcedureInput): Promise<Procedure> {
    const before = await read((tx) => ProcedureRepository.get(tx, id));
    if (!before) throw notFound(`procedure ${id} not found`);

    const willChangeBody =
      (input.content !== undefined && input.content !== before.content) ||
      (input.whenToUse !== undefined && input.whenToUse !== before.whenToUse);

    let nextEmbedding: number[] | undefined;
    if (willChangeBody) {
      const embedText = await buildEmbedText(
        before.name,
        input.whenToUse ?? before.whenToUse,
        input.content ?? before.content,
      );
      nextEmbedding = await embedder.embed(embedText);
    }

    // List of property keys that actually changed — used as audit payload.
    const changes = (Object.keys(input) as Array<keyof UpdateProcedureInput>).filter(
      (k) => k !== 'actor' && k !== 'reason' && input[k] !== undefined,
    );
    const reason = input.reason ?? 'manual update';

    const now = new Date();
    return write(async (tx) => {
      // Snapshot pre-update state.
      await AuditService.revise({
        tx,
        before,
        kind: 'procedure',
        reason,
        actor: input.actor,
        payload: { changes },
      });

      // Body change → two-node supersession, matching Facts/Preferences: keep
      // the old node's body intact and retire it, and create a NEW node at v+1
      // carrying the new body. Only the new node stays live; the version chain
      // is walkable via :SUPERSEDES (and audit). The old node is NOT mutated —
      // overwriting it plus cloning was the duplication bug this fixes.
      if (willChangeBody) {
        const supersedingClone: Procedure = {
          ...before,
          id: newId(),
          version: before.version + 1,
          content: input.content ?? before.content,
          whenToUse: input.whenToUse ?? before.whenToUse,
          embedding: nextEmbedding ?? before.embedding,
          successRate: input.successRate ?? before.successRate,
          invocationCount: input.invocationCount ?? before.invocationCount,
          lastSuccessAt: input.lastSuccessAt ?? before.lastSuccessAt,
          expiresAt: input.expiresAt ?? before.expiresAt,
          createdAt: now,
          updatedAt: now,
        };
        const created = await ProcedureRepository.create(tx, supersedingClone);
        // supersede() also retires the old node (sets its expiresAt).
        await ProcedureRepository.supersede(tx, {
          oldId: id,
          newId: created.id,
          reason,
          at: now,
        });
        await AuditService.record({
          tx,
          kind: 'supersede',
          targetId: created.id,
          targetKind: 'procedure',
          actor: input.actor,
          payload: { supersedes: id, newVersion: created.version },
        });
        return created;
      }

      // Non-body edits (telemetry / expiresAt) stay in-place on the same id.
      const updated = await ProcedureRepository.update(tx, id, {
        successRate: input.successRate,
        invocationCount: input.invocationCount,
        lastSuccessAt: input.lastSuccessAt,
        expiresAt: input.expiresAt,
        updatedAt: now,
      });
      if (!updated) throw notFound(`procedure ${id} disappeared during update`);
      return updated;
    });
  }

  async function get(id: string): Promise<Procedure | null> {
    return read((tx) => ProcedureRepository.get(tx, id));
  }

  async function getByName(name: string, projectId?: string): Promise<Procedure | null> {
    return read((tx) => ProcedureRepository.getByName(tx, { name, projectId: projectId ?? null }));
  }

  async function list(opts: { scope?: RetrievalScope; limit?: number } = {}): Promise<Procedure[]> {
    return read((tx) => ProcedureRepository.list(tx, opts));
  }

  async function softDelete(id: string, actor?: string): Promise<void> {
    await write(async (tx) => {
      await ProcedureRepository.softDelete(tx, id, new Date());
      await AuditService.record({
        tx,
        kind: 'soft_delete',
        targetId: id,
        targetKind: 'procedure',
        actor,
      });
    });
  }

  return { create, update, get, getByName, list, softDelete };
}

export type ProcedureService = ReturnType<typeof createProcedureService>;
