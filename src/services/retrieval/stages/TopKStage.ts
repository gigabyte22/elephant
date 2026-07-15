// Slice each candidate map down to ctx.limit by
// rerankScore ?? blendedScore DESC. Applies per-type so the four result
// collections are independently bounded.

import type { RetrievalStage } from '../types.ts';

export function TopKStage(): RetrievalStage {
  return {
    name: 'TopK',
    async run(ctx, state) {
      state.facts = slice(state.facts, ctx.limit, (c) => c.rerankScore ?? c.blendedScore ?? 0);
      state.chunks = slice(state.chunks, ctx.limit, (c) => c.blendedScore ?? 0);
      state.preferences = slice(state.preferences, ctx.limit, (c) => c.blendedScore ?? 0);
      state.insights = slice(state.insights, ctx.limit, (c) => c.blendedScore ?? 0);
      state.knowledgeChunks = slice(state.knowledgeChunks, ctx.limit, (c) => c.blendedScore ?? 0);
      state.procedures = slice(state.procedures, ctx.limit, (c) => c.blendedScore ?? 0);
      state.research = slice(state.research, ctx.limit, (c) => c.blendedScore ?? 0);
      return state;
    },
  };
}

function slice<T>(map: Map<string, T>, limit: number, scoreOf: (v: T) => number): Map<string, T> {
  if (map.size <= limit) return map;
  const sorted = Array.from(map.entries()).sort((a, b) => scoreOf(b[1]) - scoreOf(a[1]));
  return new Map(sorted.slice(0, limit));
}
