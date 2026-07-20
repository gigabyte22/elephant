// Research is project-scoped knowledge: same node shape as KnowledgeDocument
// but with `projectId` required. The service layer enforces that invariant
// and otherwise delegates to ResearchRepository.

import { createHash } from 'node:crypto';
import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import type { LLMAdapter } from '../adapters/llm/types.ts';
import { read, write } from '../config/neo4j.ts';
import { badRequest, notFound } from '../http/errors.ts';
import type { Research } from '../models/types.ts';
import { ResearchRepository } from '../repositories/ResearchRepository.ts';
import type { RetrievalScope } from '../repositories/scope.ts';
import { newId } from '../utils/ids.ts';
import { AuditService } from './AuditService.ts';

interface Deps {
  llm: LLMAdapter;
  embedder: EmbeddingAdapter;
  config: {
    summaryThresholdTokens: number;
    summaryTargetTokens: number;
    embedderMaxInputTokens?: number;
  };
}

export interface CreateResearchInput {
  id?: string;
  title: string;
  source: string;
  sourceUri?: string;
  content: string;
  summary?: string;
  tags?: string[];
  projectId: string;
  userId?: string;
  expiresAt?: Date | null;
  actor?: string;
}

export interface UpdateResearchInput {
  title?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  sourceUri?: string;
  expiresAt?: Date | null;
  actor?: string;
  reason?: string;
}

export function createResearchService(deps: Deps) {
  const { llm, embedder, config } = deps;
  const embedderLimit = Math.min(
    embedder.maxInputTokens,
    config.embedderMaxInputTokens ?? embedder.maxInputTokens,
  );

  // Explicit summary is validated against the embedder limit; otherwise long
  // content is LLM-summarized and short content doubles as its own summary.
  async function resolveSummary(content: string, explicit?: string): Promise<string> {
    if (explicit) {
      const sumTokens = await embedder.countTokens(explicit);
      if (sumTokens > embedderLimit) {
        throw badRequest(
          `summary exceeds embedder limit of ${embedderLimit} tokens (got ~${sumTokens})`,
        );
      }
      return explicit;
    }
    const tokens = await embedder.countTokens(content);
    if (tokens > config.summaryThresholdTokens) {
      return llm.summarize({ text: content, targetTokens: config.summaryTargetTokens });
    }
    return content;
  }

  async function create(input: CreateResearchInput): Promise<Research> {
    if (!input.projectId) throw badRequest('research items require projectId');

    const summary = await resolveSummary(input.content, input.summary);
    const embedding = await embedder.embed(summary);
    const now = new Date();
    const research: Research = {
      id: input.id ?? newId(),
      title: input.title,
      source: input.source,
      sourceUri: input.sourceUri,
      content: input.content,
      contentHash: createHash('sha256').update(input.content).digest('hex'),
      summary,
      embedding,
      tags: input.tags ?? [],
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
      projectId: input.projectId,
      ...(input.userId !== undefined && { userId: input.userId }),
    };

    return write(async (tx) => {
      const created = await ResearchRepository.create(tx, research);
      await AuditService.record({
        tx,
        kind: 'create',
        targetId: created.id,
        targetKind: 'research',
        actor: input.actor,
        payload: { projectId: created.projectId, source: created.source },
      });
      return created;
    });
  }

  async function update(id: string, input: UpdateResearchInput): Promise<Research> {
    const before = await read((tx) => ResearchRepository.get(tx, id));
    if (!before) throw notFound(`research ${id}`);

    const contentChanged = input.content !== undefined && input.content !== before.content;

    let summary: string | undefined;
    let embedding: number[] | undefined;
    let contentHash: string | undefined;
    if (contentChanged && input.content !== undefined) {
      summary = await resolveSummary(input.content, input.summary);
      embedding = await embedder.embed(summary);
      contentHash = createHash('sha256').update(input.content).digest('hex');
    } else if (input.summary !== undefined && input.summary !== before.summary) {
      summary = await resolveSummary(before.content ?? before.summary, input.summary);
      embedding = await embedder.embed(summary);
    }

    const changes = (
      ['title', 'content', 'summary', 'tags', 'sourceUri', 'expiresAt'] as const
    ).filter((k) => input[k] !== undefined);

    return write(async (tx) => {
      await AuditService.revise({
        tx,
        before,
        kind: 'research',
        reason: input.reason ?? 'manual update',
        actor: input.actor,
        payload: { changes, contentChanged },
      });
      const updated = await ResearchRepository.update(tx, id, {
        title: input.title,
        content: contentChanged ? input.content : undefined,
        summary,
        embedding,
        contentHash,
        tags: input.tags,
        sourceUri: input.sourceUri,
        expiresAt: input.expiresAt,
        updatedAt: new Date(),
      });
      if (!updated) throw notFound(`research ${id}`);
      return updated;
    });
  }

  async function get(id: string): Promise<Research | null> {
    return read((tx) => ResearchRepository.get(tx, id));
  }

  async function list(opts: { scope?: RetrievalScope; limit?: number } = {}): Promise<Research[]> {
    return read((tx) => ResearchRepository.list(tx, opts));
  }

  async function softDelete(id: string, actor?: string): Promise<void> {
    await write(async (tx) => {
      await ResearchRepository.softDelete(tx, id, new Date());
      await AuditService.record({
        tx,
        kind: 'soft_delete',
        targetId: id,
        targetKind: 'research',
        actor,
      });
    });
  }

  return { create, update, get, list, softDelete };
}

export type ResearchService = ReturnType<typeof createResearchService>;
