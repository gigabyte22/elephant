import type { ManagedTransaction } from 'neo4j-driver';
import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import type { LLMAdapter } from '../adapters/llm/types.ts';
import { read, write } from '../config/neo4j.ts';
import { badRequest } from '../http/errors.ts';
import type { Chunk, Episode, Fact } from '../models/types.ts';
import { ChunkRepository } from '../repositories/ChunkRepository.ts';
import { EntityRepository } from '../repositories/EntityRepository.ts';
import { EpisodeRepository } from '../repositories/EpisodeRepository.ts';
import { FactRepository } from '../repositories/FactRepository.ts';
import { newId } from '../utils/ids.ts';
import { AuditService } from './AuditService.ts';
import { type Chunker, createChunker } from './Chunker.ts';

const INGEST_ACTOR = 'memory-ingest';

interface Deps {
  llm: LLMAdapter;
  embedder: EmbeddingAdapter;
  chunker?: Chunker;
  config: {
    chunkTargetTokens: number;
    chunkOverlapTokens: number;
    summaryThresholdTokens: number;
    summaryTargetTokens: number;
    embedderMaxInputTokens?: number;
  };
}

interface IngestEpisodeInput {
  id?: string;
  agentId: string;
  sessionId: string;
  rawTranscript: string;
  summary?: string;
  timestamp?: Date;
  projectId?: string;
  userId?: string;
  origin?: 'user' | 'cron' | 'event' | 'system' | 'ingest';
  isolated?: boolean;
}

interface SaveFactInput {
  id?: string;
  content: string;
  category?: string;
  confidence?: number;
  importance?: number;
  validFrom?: Date;
  entityNames?: string[];
  sourceEpisodeId?: string;
  projectId?: string;
  userId?: string;
}

const SUPERSEDE_VECTOR_THRESHOLD = 0.85;

// Fraction of the LLM context usable as summarizer INPUT — the rest covers the
// system prompt, the instruction wrapper, and the response budget. Mirrors the
// dreamer's EXTRACTION_CONTEXT_USABLE stance.
const SUMMARY_CONTEXT_USABLE = 0.6;
// Map-reduce rounds before giving up and hard-truncating: each round shrinks
// the text by ~an order of magnitude, so 3 covers any sane transcript.
const SUMMARY_MAX_ROUNDS = 3;

/**
 * Map-reduce summarize that never exceeds the LLM context: oversized text is
 * chunked (in LLM tokens, not embedder tokens), each piece summarized, and the
 * joined piece-summaries reduced again until they fit. A giant transcript used
 * to go up as ONE prompt — a guaranteed "context exceeded" after minutes of
 * prefill, which wedged every slot of the shared llama.cpp server (2026-07-11
 * starvation incident).
 */
export function createBoundedSummarizer(
  llm: LLMAdapter,
  targetTokens: number,
): (text: string, tokens: number) => Promise<string> {
  const chunker = createChunker({ countTokens: (t) => llm.countTokens(t) });
  return async function summarizeBounded(text: string, tokens: number): Promise<string> {
    const inputBudget = Math.floor(llm.maxContextTokens * SUMMARY_CONTEXT_USABLE);
    let current = text;
    let currentTokens = tokens;
    for (let round = 0; round < SUMMARY_MAX_ROUNDS; round++) {
      if (currentTokens <= inputBudget) {
        return llm.summarize({ text: current, targetTokens });
      }
      const pieces = await chunker.chunk(current, { maxTokens: inputBudget, overlapTokens: 0 });
      const partials: string[] = [];
      for (const piece of pieces) {
        partials.push(await llm.summarize({ text: piece.text, targetTokens }));
      }
      current = partials.join('\n');
      currentTokens = await llm.countTokens(current);
    }
    console.warn(
      `[ingest] summary map-reduce did not converge after ${SUMMARY_MAX_ROUNDS} rounds; truncating input`,
    );
    return llm.summarize({ text: current.slice(0, inputBudget * 4), targetTokens });
  };
}

// Defaults differ between the single-write and batch paths:
// explicit POST /facts is treated as high-confidence user input,
// batch writes (often LLM-mediated) keep the more conservative ExtractedFact defaults.
const SINGLE_WRITE_DEFAULTS = { confidence: 0.9, importance: 0.6 } as const;
const BATCH_WRITE_DEFAULTS = { confidence: 0.7, importance: 0.5 } as const;

export function createMemoryIngestionService(deps: Deps) {
  const { llm, embedder, config } = deps;
  const chunker = deps.chunker ?? createChunker({ countTokens: (t) => embedder.countTokens(t) });

  // The effective per-input token cap for the embedder. Env override lets
  // users tighten this for adapters that misreport or for safety.
  const embedderLimit = Math.min(
    embedder.maxInputTokens,
    config.embedderMaxInputTokens ?? embedder.maxInputTokens,
  );
  // Target chunk size lives under the embedder cap so a pathologically long
  // "paragraph" doesn't push a chunk over the line after overlap is added.
  const chunkTarget = Math.min(config.chunkTargetTokens, embedderLimit);

  const summarizeBounded = createBoundedSummarizer(llm, config.summaryTargetTokens);

  async function ingestEpisode(input: IngestEpisodeInput): Promise<Episode> {
    const rawTokens = await embedder.countTokens(input.rawTranscript);

    // 1. Always chunk — short inputs yield a single Chunk, keeping the graph
    //    shape uniform between long and short Episodes.
    const pieces = await chunker.chunk(input.rawTranscript, {
      maxTokens: chunkTarget,
      overlapTokens: config.chunkOverlapTokens,
    });
    if (pieces.length === 0) {
      // z.string().min(1) prevents truly empty, but trim() in chunker could.
      throw badRequest('rawTranscript is empty after trimming');
    }

    // 2. Episode-level summary for top-level recall.
    let summary: string;
    if (input.summary) {
      const sumTokens = await embedder.countTokens(input.summary);
      if (sumTokens > embedderLimit) {
        throw badRequest(
          `summary exceeds embedder limit of ${embedderLimit} tokens (got ~${sumTokens}). Supply a shorter summary or omit it and let the service generate one.`,
        );
      }
      summary = input.summary;
    } else if (rawTokens > config.summaryThresholdTokens) {
      try {
        summary = await summarizeBounded(input.rawTranscript, rawTokens);
      } catch (err) {
        // A failed summarize must not fail the ingestion — the caller retries
        // the identical oversized payload forever (poison pill). Degrade to a
        // clipped head; the full transcript still lands in chunks for the
        // dreamer to distill.
        console.warn('[ingest] summarize failed, using clipped head:', (err as Error).message);
        summary = input.rawTranscript.slice(0, config.summaryTargetTokens * 4);
      }
    } else {
      // Short enough to embed directly — no LLM call, no truncation.
      summary = input.rawTranscript;
    }

    // 3. Batched embed: summary + all chunks in one adapter call.
    const texts = [summary, ...pieces.map((p) => p.text)];
    const vectors = await embedder.embedBatch(texts);
    const summaryVec = vectors[0] ?? [];
    const chunkVecs = vectors.slice(1);

    const now = input.timestamp ?? new Date();
    const episodeId = input.id ?? newId();
    const episode: Episode = {
      id: episodeId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      timestamp: now,
      rawTranscript: input.rawTranscript,
      summary,
      embedding: summaryVec,
      origin: input.origin,
      isolated: input.isolated,
      projectId: input.projectId,
      userId: input.userId,
    };

    const chunks: Chunk[] = pieces.map((p, i) => ({
      id: newId(),
      episodeId,
      position: p.position,
      text: p.text,
      tokenCount: p.tokenCount,
      embedding: chunkVecs[i] ?? [],
      createdAt: now,
      projectId: input.projectId,
      userId: input.userId,
    }));

    // 4. Persist Episode + Chunks + relationships atomically.
    return write(async (tx) => {
      const created = await EpisodeRepository.create(tx, episode);
      await ChunkRepository.createForEpisode(tx, { episodeId: created.id, chunks });
      return created;
    });
  }

  async function saveFact(input: SaveFactInput): Promise<Fact> {
    const tokens = await embedder.countTokens(input.content);
    if (tokens > embedderLimit) {
      throw badRequest(
        `fact content exceeds embedder limit of ${embedderLimit} tokens (got ~${tokens}). Shorten the fact — facts should be single-sentence claims.`,
      );
    }
    const embedding = await embedder.embed(input.content);
    return persistFact(input, embedding, SINGLE_WRITE_DEFAULTS);
  }

  async function saveFacts(inputs: SaveFactInput[]): Promise<Fact[]> {
    // Pre-check every content against the embedder limit so a bad apple
    // doesn't cause a partial write.
    for (const input of inputs) {
      const tokens = await embedder.countTokens(input.content);
      if (tokens > embedderLimit) {
        throw badRequest(
          `fact content exceeds embedder limit of ${embedderLimit} tokens (got ~${tokens}) in batch entry: "${input.content.slice(0, 80)}…"`,
        );
      }
    }
    const embeddings = await embedder.embedBatch(inputs.map((i) => i.content));
    const out: Fact[] = [];
    for (const [i, input] of inputs.entries()) {
      out.push(await persistFact(input, embeddings[i] ?? [], BATCH_WRITE_DEFAULTS));
    }
    return out;
  }

  // Resolves entities, persists the fact, then runs the post-write supersede check.
  // Defaults are passed in so single-write and batch paths can keep their distinct
  // confidence/importance baselines without duplicating the persistence body.
  async function persistFact(
    input: SaveFactInput,
    embedding: number[],
    defaults: { confidence: number; importance: number },
  ): Promise<Fact> {
    const now = new Date();

    // Unknown entities are seeded with the fact's embedding — good enough until
    // dreaming refines with proper entity-specific embeddings.
    const entityIds = await write(async (tx) => {
      const names = input.entityNames ?? [];
      if (names.length === 0) return [];
      const entities = await EntityRepository.upsertMany(
        tx,
        names.map((name) => ({ name, type: 'Concept', embedding })),
      );
      return entities.map((e) => e.id);
    });

    const fact: Fact = {
      id: input.id ?? newId(),
      content: input.content,
      category: input.category,
      confidence: input.confidence ?? defaults.confidence,
      importance: input.importance ?? defaults.importance,
      validFrom: input.validFrom ?? now,
      validTo: null,
      recordedAt: now,
      embedding,
      entityIds,
      sourceEpisodeId: input.sourceEpisodeId,
      projectId: input.projectId,
      userId: input.userId,
    };

    const created = await write(async (tx) => {
      const c = await FactRepository.create(tx, fact);
      await AuditService.record({
        tx,
        kind: 'create',
        targetId: c.id,
        targetKind: 'fact',
        actor: INGEST_ACTOR,
        payload: {
          category: c.category,
          sourceEpisodeId: c.sourceEpisodeId,
          confidence: c.confidence,
          importance: c.importance,
        },
      });
      return c;
    });
    await runSupersedeCheck(created);
    return created;
  }

  async function supersede(input: {
    oldId: string;
    newId: string;
    reason: string;
  }): Promise<void> {
    await write((tx) => supersedeFactWithAudit(tx, input));
  }

  async function softDelete(id: string): Promise<void> {
    await write(async (tx) => {
      await FactRepository.softDelete(tx, id, new Date());
      await AuditService.record({
        tx,
        kind: 'soft_delete',
        targetId: id,
        targetKind: 'fact',
        actor: INGEST_ACTOR,
      });
    });
  }

  // Shared body for the two callers that supersede a fact + emit the matching
  // audit event in one transaction (explicit POST /facts/:id/supersede and the
  // post-write LLM-driven supersede check).
  async function supersedeFactWithAudit(
    tx: ManagedTransaction,
    input: { oldId: string; newId: string; reason: string; confidenceDelta?: number },
  ): Promise<void> {
    const { newConfidence } = await FactRepository.supersede(tx, { ...input, at: new Date() });
    await AuditService.record({
      tx,
      kind: 'supersede',
      targetId: input.oldId,
      targetKind: 'fact',
      actor: INGEST_ACTOR,
      payload: {
        newFactId: input.newId,
        reason: input.reason,
        ...(input.confidenceDelta !== undefined ? { confidenceDelta: input.confidenceDelta } : {}),
        ...(newConfidence !== null ? { newConfidence } : {}),
      },
    });
  }

  async function runSupersedeCheck(fact: Fact): Promise<void> {
    const candidates = await read((tx) =>
      FactRepository.listSimilar(tx, {
        embedding: fact.embedding,
        limit: 10,
        minScore: SUPERSEDE_VECTOR_THRESHOLD,
        includeSuperseded: false,
        // Confine to the fact's own bucket + the unscoped personal bucket. An
        // unscoped search here let a direct POST /facts supersede a DIFFERENT
        // project's fact.
        scope: {
          projectId: fact.projectId ?? null,
          includeUnscoped: true,
          userId: fact.userId ?? null,
        },
      }),
    );
    const others = candidates.filter((c) => c.id !== fact.id);
    if (others.length === 0) return;

    let decision: Awaited<ReturnType<typeof llm.detectSupersede>>;
    try {
      decision = await llm.detectSupersede({
        candidate: { id: fact.id, content: fact.content },
        existing: others.map((o) => ({ id: o.id, content: o.content })),
      });
    } catch (err) {
      // Supersede is opportunistic dedup — an LLM hiccup must not fail ingest.
      console.warn('[supersede] check failed, skipping:', (err as Error).message);
      return;
    }
    if (!decision) return;

    await write((tx) =>
      supersedeFactWithAudit(tx, {
        oldId: decision.oldFactId,
        newId: fact.id,
        reason: decision.reason,
        confidenceDelta: decision.confidenceDelta,
      }),
    );
  }

  return { ingestEpisode, saveFact, saveFacts, supersede, softDelete };
}

export type MemoryIngestionService = ReturnType<typeof createMemoryIngestionService>;
