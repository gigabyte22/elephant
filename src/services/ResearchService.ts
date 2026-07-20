// Research is project-scoped knowledge: same node shape as KnowledgeDocument
// but with `projectId` required. The service layer enforces that invariant
// and otherwise delegates to ResearchRepository.

import { createHash } from 'node:crypto';
import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import type { LLMAdapter } from '../adapters/llm/types.ts';
import { projectToVault, tombstoneInVault } from '../adapters/vault/project.ts';
import type { VaultWriter } from '../adapters/vault/types.ts';
import { read, write } from '../config/neo4j.ts';
import { badRequest, notFound } from '../http/errors.ts';
import type { Research, ResearchChunk } from '../models/types.ts';
import { ResearchChunkRepository } from '../repositories/ResearchChunkRepository.ts';
import { ResearchRepository } from '../repositories/ResearchRepository.ts';
import type { RetrievalScope } from '../repositories/scope.ts';
import { newId } from '../utils/ids.ts';
import { AuditService } from './AuditService.ts';
import { type Chunker, createChunker } from './Chunker.ts';

interface Deps {
  llm: LLMAdapter;
  embedder: EmbeddingAdapter;
  chunker?: Chunker;
  vault?: VaultWriter;
  config: {
    chunkTargetTokens: number;
    chunkOverlapTokens: number;
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
  const { llm, embedder, config, vault } = deps;
  const chunker = deps.chunker ?? createChunker({ countTokens: embedder.countTokens });
  const embedderLimit = Math.min(
    embedder.maxInputTokens,
    config.embedderMaxInputTokens ?? embedder.maxInputTokens,
  );
  // Chunks must fit the embedder — chunk-don't-truncate, same as knowledge.
  const chunkTarget = Math.min(config.chunkTargetTokens, embedderLimit);

  // Chunk the body and batch-embed [summary, ...chunks] in one call.
  // Returns the summary vector plus fully-built chunk rows.
  async function chunkAndEmbed(input: {
    researchId: string;
    content: string;
    summary: string;
    at: Date;
    projectId: string;
    userId?: string;
  }): Promise<{ embedding: number[]; chunks: ResearchChunk[] }> {
    const pieces = await chunker.chunk(input.content, {
      maxTokens: chunkTarget,
      overlapTokens: config.chunkOverlapTokens,
    });
    if (pieces.length === 0) throw badRequest('research content produced no chunks');
    const vectors = await embedder.embedBatch([input.summary, ...pieces.map((p) => p.text)]);
    const chunks: ResearchChunk[] = pieces.map((p, i) => ({
      id: newId(),
      researchId: input.researchId,
      position: p.position,
      text: p.text,
      tokenCount: p.tokenCount,
      embedding: vectors[i + 1] ?? [],
      createdAt: input.at,
      projectId: input.projectId,
      ...(input.userId !== undefined && { userId: input.userId }),
    }));
    return { embedding: vectors[0] ?? [], chunks };
  }

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
    const now = new Date();
    const id = input.id ?? newId();
    const { embedding, chunks } = await chunkAndEmbed({
      researchId: id,
      content: input.content,
      summary,
      at: now,
      projectId: input.projectId,
      userId: input.userId,
    });
    const research: Research = {
      id,
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

    const created = await write(async (tx) => {
      const item = await ResearchRepository.create(tx, research);
      await ResearchChunkRepository.createForResearch(tx, { researchId: item.id, chunks });
      await AuditService.record({
        tx,
        kind: 'create',
        targetId: item.id,
        targetKind: 'research',
        actor: input.actor,
        payload: { projectId: item.projectId, source: item.source, chunkCount: chunks.length },
      });
      return item;
    });
    await projectToVault(vault, 'research', created);
    return created;
  }

  async function update(id: string, input: UpdateResearchInput): Promise<Research> {
    const before = await read((tx) => ResearchRepository.get(tx, id));
    if (!before) throw notFound(`research ${id}`);

    const contentChanged = input.content !== undefined && input.content !== before.content;

    let summary: string | undefined;
    let embedding: number[] | undefined;
    let contentHash: string | undefined;
    let newChunks: ResearchChunk[] | undefined;
    if (contentChanged && input.content !== undefined) {
      summary = await resolveSummary(input.content, input.summary);
      contentHash = createHash('sha256').update(input.content).digest('hex');
      const chunked = await chunkAndEmbed({
        researchId: id,
        content: input.content,
        summary,
        at: new Date(),
        projectId: before.projectId,
        userId: before.userId,
      });
      embedding = chunked.embedding;
      newChunks = chunked.chunks;
    } else if (input.summary !== undefined && input.summary !== before.summary) {
      summary = await resolveSummary(before.content ?? before.summary, input.summary);
      embedding = await embedder.embed(summary);
    }

    const changes = (
      ['title', 'content', 'summary', 'tags', 'sourceUri', 'expiresAt'] as const
    ).filter((k) => input[k] !== undefined);

    const updated = await write(async (tx) => {
      await AuditService.revise({
        tx,
        before,
        kind: 'research',
        reason: input.reason ?? 'manual update',
        actor: input.actor,
        payload: { changes, contentChanged, ...(newChunks && { chunkCount: newChunks.length }) },
      });
      const item = await ResearchRepository.update(tx, id, {
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
      if (!item) throw notFound(`research ${id}`);
      if (newChunks) {
        await ResearchChunkRepository.deleteForResearch(tx, id);
        await ResearchChunkRepository.createForResearch(tx, { researchId: id, chunks: newChunks });
      }
      return item;
    });
    await projectToVault(vault, 'research', updated);
    return updated;
  }

  async function get(id: string): Promise<Research | null> {
    return read((tx) => ResearchRepository.get(tx, id));
  }

  async function list(opts: { scope?: RetrievalScope; limit?: number } = {}): Promise<Research[]> {
    return read((tx) => ResearchRepository.list(tx, opts));
  }

  async function softDelete(id: string, actor?: string): Promise<void> {
    // Pre-read for the vault tombstone ref (needs projectId for the path).
    const existing = await read((tx) => ResearchRepository.get(tx, id));
    const at = new Date();
    await write(async (tx) => {
      await ResearchRepository.softDelete(tx, id, at);
      // Chunks are derived data (reproducible from on-node content) — hard
      // delete so deleted research can never resurface through chunk recall.
      await ResearchChunkRepository.deleteForResearch(tx, id);
      await AuditService.record({
        tx,
        kind: 'soft_delete',
        targetId: id,
        targetKind: 'research',
        actor,
      });
    });
    if (existing) await tombstoneInVault(vault, 'research', existing, at);
  }

  return { create, update, get, list, softDelete };
}

export type ResearchService = ReturnType<typeof createResearchService>;
