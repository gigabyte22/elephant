// Research is project-scoped knowledge: same node shape as KnowledgeDocument
// but with `projectId` required. The service layer enforces that invariant
// and otherwise delegates to ResearchRepository.

import { createHash } from 'node:crypto';
import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import type { LLMAdapter } from '../adapters/llm/types.ts';
import { read, write } from '../config/neo4j.ts';
import { badRequest } from '../http/errors.ts';
import type { Research, Scope } from '../models/types.ts';
import { ResearchRepository } from '../repositories/ResearchRepository.ts';
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

export function createResearchService(deps: Deps) {
  const { llm, embedder, config } = deps;
  const embedderLimit = Math.min(
    embedder.maxInputTokens,
    config.embedderMaxInputTokens ?? embedder.maxInputTokens,
  );

  async function create(input: CreateResearchInput): Promise<Research> {
    if (!input.projectId) throw badRequest('research items require projectId');

    const tokens = await embedder.countTokens(input.content);
    let summary: string;
    if (input.summary) {
      const sumTokens = await embedder.countTokens(input.summary);
      if (sumTokens > embedderLimit) {
        throw badRequest(
          `summary exceeds embedder limit of ${embedderLimit} tokens (got ~${sumTokens})`,
        );
      }
      summary = input.summary;
    } else if (tokens > config.summaryThresholdTokens) {
      summary = await llm.summarize({
        text: input.content,
        targetTokens: config.summaryTargetTokens,
      });
    } else {
      summary = input.content;
    }

    const embedding = await embedder.embed(summary);
    const now = new Date();
    const research: Research = {
      id: input.id ?? newId(),
      title: input.title,
      source: input.source,
      sourceUri: input.sourceUri,
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

  async function get(id: string): Promise<Research | null> {
    return read((tx) => ResearchRepository.get(tx, id));
  }

  async function list(opts: { scope?: Scope; limit?: number } = {}): Promise<Research[]> {
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

  return { create, get, list, softDelete };
}

export type ResearchService = ReturnType<typeof createResearchService>;
