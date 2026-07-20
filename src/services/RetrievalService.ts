// Thin composition root — all recall logic lives in src/services/retrieval/
// stages. This file turns a RecallQuery into a RetrievalContext, runs the
// injected pipeline, and projects the resulting PipelineState into a typed
// RecallResult (still internal; wire mapping happens in the route).

import type { Entity, Fact } from '../models/types.ts';
import type { RetrievalConfig } from './retrieval/config.ts';
import type {
  CandidateSource,
  Pipeline,
  PipelineState,
  RecallQuery,
  RecallResult,
  RetrievalContext,
} from './retrieval/types.ts';

interface Deps {
  pipeline: Pipeline;
  config: RetrievalConfig;
}

export function createRetrievalService(deps: Deps) {
  const { pipeline, config } = deps;

  async function recall(query: RecallQuery): Promise<RecallResult> {
    const { state, ctx } = await runPipeline(query);
    return projectResult(state, ctx, /* withTrace */ false);
  }

  async function recallWithTrace(query: RecallQuery): Promise<RecallResult> {
    const { state, ctx } = await runPipeline(query);
    return projectResult(state, ctx, /* withTrace */ true);
  }

  async function runPipeline(
    query: RecallQuery,
  ): Promise<{ state: PipelineState; ctx: RetrievalContext }> {
    const ctx: RetrievalContext = {
      query,
      queryVector: [],
      ftQuery: '',
      now: query.now ?? new Date(),
      config,
      stageTimingsMs: {},
      limit: query.limit ?? 20,
    };
    const state = await pipeline.run(ctx);
    return { state, ctx };
  }

  return { recall, recallWithTrace };
}

export type RetrievalService = ReturnType<typeof createRetrievalService>;

// Re-export for consumers (HTTP layer) who want the query / result types.
export type { RecallQuery, RecallResult } from './retrieval/types.ts';

type Scored = { rerankScore?: number; blendedScore?: number };

// Sort candidate map entries by the final pipeline comparator (rerank then
// blended) and project each through a mapper.
function sortAndMap<V extends Scored, R>(map: Map<string, V>, mapper: (c: V) => R): R[] {
  return Array.from(map.values())
    .sort((a, b) => (b.rerankScore ?? b.blendedScore ?? 0) - (a.rerankScore ?? a.blendedScore ?? 0))
    .map(mapper);
}

function projectResult(
  state: PipelineState,
  ctx: RetrievalContext,
  withTrace: boolean,
): RecallResult {
  const facts = sortAndMap(
    state.facts,
    (
      c,
    ): Fact & {
      score: number;
      expansionReason: CandidateSource;
      originAgentId?: string | null;
      originSessionId?: string | null;
    } => ({
      ...c.fact,
      score: c.rerankScore ?? c.blendedScore ?? 0,
      expansionReason: c.expansionReason,
      originAgentId: c.originAgentId ?? null,
      originSessionId: c.originSessionId ?? null,
    }),
  );

  const entities: Entity[] = Array.from(state.entities.values());
  const result: RecallResult = { facts, entities };

  if (ctx.query.includeChunks) {
    result.chunks = sortAndMap(state.chunks, (c) => ({
      ...c.chunk,
      score: c.blendedScore ?? 0,
      expansionReason: c.expansionReason,
    }));
  }

  if (ctx.query.includePreferences !== false && state.preferences.size > 0) {
    result.preferences = sortAndMap(state.preferences, (c) => ({
      ...c.preference,
      score: c.blendedScore ?? 0,
    }));
  }

  if (ctx.query.includeInsights !== false && state.insights.size > 0) {
    result.insights = sortAndMap(state.insights, (c) => ({
      ...c.insight,
      score: c.blendedScore ?? 0,
    }));
  }

  if (ctx.query.includeKnowledge && state.knowledgeChunks.size > 0) {
    result.knowledgeChunks = sortAndMap(state.knowledgeChunks, (c) => ({
      ...c.chunk,
      score: c.blendedScore ?? 0,
      expansionReason: c.expansionReason,
    }));
  }

  if (ctx.query.includeProcedures && state.procedures.size > 0) {
    result.procedures = sortAndMap(state.procedures, (c) => ({
      ...c.procedure,
      score: c.blendedScore ?? 0,
      expansionReason: c.expansionReason,
    }));
  }

  if (ctx.query.includeResearch && state.research.size > 0) {
    result.research = sortAndMap(state.research, (c) => ({
      ...c.research,
      score: c.blendedScore ?? 0,
    }));
  }

  if (ctx.query.includeResearch && state.researchChunks.size > 0) {
    result.researchChunks = sortAndMap(state.researchChunks, (c) => ({
      ...c.chunk,
      score: c.blendedScore ?? 0,
      expansionReason: c.expansionReason,
    }));
  }

  if (ctx.query.includeIntentions && state.intentions.size > 0) {
    result.intentions = sortAndMap(state.intentions, (c) => ({
      ...c.intention,
      score: c.blendedScore ?? 0,
    }));
  }

  if (withTrace || ctx.query.debug) {
    result.trace = {
      stageTimingsMs: ctx.stageTimingsMs,
      rerankUsed: facts.some((f) => f.expansionReason === 'rerank'),
      candidatesSeen: {
        facts: state.facts.size,
        chunks: state.chunks.size,
        preferences: state.preferences.size,
        insights: state.insights.size,
        knowledgeChunks: state.knowledgeChunks.size,
        procedures: state.procedures.size,
        research: state.research.size,
        researchChunks: state.researchChunks.size,
      },
    };
  }

  return result;
}
