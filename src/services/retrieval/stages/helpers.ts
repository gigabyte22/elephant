// Shared helpers used by the hybrid-search source stages. Keeps the per-stage
// files focused on the repository call and filter, not the map bookkeeping.

import type {
  Chunk,
  Fact,
  Intention,
  KnowledgeChunk,
  Procedure,
  Research,
} from '../../../models/types.ts';
import type {
  CandidateSource,
  ChunkCandidate,
  FactCandidate,
  PipelineState,
  ProcedureCandidate,
  RetrievalContext,
} from '../types.ts';

export function overfetchLimit(ctx: RetrievalContext): number {
  return ctx.limit * ctx.config.overfetchMultiplier;
}

// Upsert pattern shared by FactVectorSource and FactFullTextSource. Both stages
// push a ranked source onto the candidate (creating the entry on first sight)
// and stamp `hasDirectHit=true` because a direct vector/FT match is the
// definition of a non-expanded hit.
export function upsertFactHits(
  state: PipelineState,
  hits: ReadonlyArray<Fact & { score: number }>,
  source: Extract<CandidateSource, 'fact_vector' | 'fact_fulltext'>,
): void {
  hits.forEach((fact, i) => {
    const entry: FactCandidate = state.facts.get(fact.id) ?? {
      fact,
      sources: [],
      expansionReason: source,
      hasDirectHit: true,
    };
    entry.sources.push({ source, rank: i, rawScore: fact.score });
    entry.hasDirectHit = true;
    state.facts.set(fact.id, entry);
  });
}

export function upsertChunkHits(
  state: PipelineState,
  hits: ReadonlyArray<Chunk & { score: number }>,
  source: Extract<CandidateSource, 'chunk_vector' | 'chunk_fulltext'>,
): void {
  hits.forEach((chunk, i) => {
    const entry: ChunkCandidate = state.chunks.get(chunk.id) ?? {
      chunk,
      sources: [],
      expansionReason: source,
    };
    entry.sources.push({ source, rank: i, rawScore: chunk.score });
    state.chunks.set(chunk.id, entry);
  });
}

// v1.2 — same upsert shape for the new fused-source categories. Each stage
// only differs in the candidate map it fills and the source tag it stamps;
// this generic covers every chunk-shaped map (knowledgeChunks, researchChunks).
export function upsertFusedChunkHits<C extends { id: string }>(
  map: Map<
    string,
    {
      chunk: C;
      sources: Array<{ source: CandidateSource; rank: number; rawScore?: number }>;
      fusedScore?: number;
      blendedScore?: number;
      expansionReason: CandidateSource;
    }
  >,
  hits: ReadonlyArray<C & { score: number }>,
  source: CandidateSource,
): void {
  hits.forEach((chunk, i) => {
    const entry = map.get(chunk.id) ?? {
      chunk,
      sources: [],
      expansionReason: source,
    };
    entry.sources.push({ source, rank: i, rawScore: chunk.score });
    map.set(chunk.id, entry);
  });
}

export function upsertKnowledgeChunkHits(
  state: PipelineState,
  hits: ReadonlyArray<KnowledgeChunk & { score: number }>,
  source: Extract<CandidateSource, 'knowledge_chunk_vector' | 'knowledge_chunk_fulltext'>,
): void {
  upsertFusedChunkHits(state.knowledgeChunks, hits, source);
}

export function upsertProcedureHits(
  state: PipelineState,
  hits: ReadonlyArray<Procedure & { score: number }>,
  source: Extract<CandidateSource, 'procedure_vector' | 'procedure_fulltext'>,
): void {
  hits.forEach((procedure, i) => {
    const entry: ProcedureCandidate = state.procedures.get(procedure.id) ?? {
      procedure,
      sources: [],
      expansionReason: source,
    };
    entry.sources.push({ source, rank: i, rawScore: procedure.score });
    state.procedures.set(procedure.id, entry);
  });
}

// Research is single-source (vector only) — no fusion list, just first-write-wins.
export function upsertResearchHits(
  state: PipelineState,
  hits: ReadonlyArray<Research & { score: number }>,
): void {
  for (const research of hits) {
    if (!state.research.has(research.id)) {
      state.research.set(research.id, { research, rawScore: research.score });
    }
  }
}

// Intentions are single-source (vector only), same shape as research.
export function upsertIntentionHits(
  state: PipelineState,
  hits: ReadonlyArray<Intention & { score: number }>,
): void {
  for (const intention of hits) {
    if (!state.intentions.has(intention.id)) {
      state.intentions.set(intention.id, { intention, rawScore: intention.score });
    }
  }
}
