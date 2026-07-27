// Slice each candidate map down to ctx.limit by
// rerankScore ?? blendedScore DESC. Applies per-type so every result
// collection is independently bounded — a map missed here escapes `limit`
// entirely and ships at overfetch size.

import type { RetrievalStage } from '../types.ts';

export function TopKStage(): RetrievalStage {
  return {
    name: 'TopK',
    async run(ctx, state) {
      // Snapshot BEFORE truncating. projectResult reads these sizes AFTER the
      // pipeline runs, so `candidatesSeen` was mathematically incapable of
      // exceeding `limit` — it could never reveal that 200 candidates were
      // fetched and 195 filtered away, which is the exact failure it exists to
      // surface.
      ctx.candidatesSeen = {
        facts: state.facts.size,
        chunks: state.chunks.size,
        preferences: state.preferences.size,
        insights: state.insights.size,
        knowledgeChunks: state.knowledgeChunks.size,
        procedures: state.procedures.size,
        research: state.research.size,
        researchChunks: state.researchChunks.size,
        intentions: state.intentions.size,
        observations: state.observations.size,
      };
      state.facts = slice(state.facts, ctx.limit, (c) => c.rerankScore ?? c.blendedScore ?? 0);
      state.chunks = slice(state.chunks, ctx.limit, (c) => c.blendedScore ?? 0);
      state.preferences = slice(state.preferences, ctx.limit, (c) => c.blendedScore ?? 0);
      state.insights = slice(state.insights, ctx.limit, (c) => c.blendedScore ?? 0);
      state.knowledgeChunks = slice(state.knowledgeChunks, ctx.limit, (c) => c.blendedScore ?? 0);
      state.procedures = slice(state.procedures, ctx.limit, (c) => c.blendedScore ?? 0);
      state.research = slice(state.research, ctx.limit, (c) => c.blendedScore ?? 0);
      state.researchChunks = slice(state.researchChunks, ctx.limit, (c) => c.blendedScore ?? 0);
      state.intentions = slice(state.intentions, ctx.limit, (c) => c.blendedScore ?? 0);
      state.observations = slice(state.observations, ctx.limit, (c) => c.blendedScore ?? 0);
      return state;
    },
  };
}

function slice<T>(map: Map<string, T>, limit: number, scoreOf: (v: T) => number): Map<string, T> {
  if (map.size <= limit) return map;
  const sorted = Array.from(map.entries()).sort((a, b) => scoreOf(b[1]) - scoreOf(a[1]));
  return new Map(sorted.slice(0, limit));
}
