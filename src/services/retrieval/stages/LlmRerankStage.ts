// Optional listwise LLM rerank over the top-K facts by blended score.
// Off by default (config.rerank.enabled and/or query.rerank must be true)
// and gracefully no-ops when the adapter doesn't implement `rerank`.
//
// Budget guard: we estimate the prompt size (query + candidate contents
// truncated to ~400 chars each) via the LLM adapter's countTokens helper;
// if the estimate exceeds 40% of maxContextTokens we halve topK before
// calling so long content can't blow up the model.

import type { LLMAdapter } from '../../../adapters/llm/types.ts';
import type { FactCandidate, RetrievalStage } from '../types.ts';

const CANDIDATE_CONTENT_CHARS = 400;
const PROMPT_BUDGET_RATIO = 0.4;

export function LlmRerankStage(llm: LLMAdapter): RetrievalStage {
  return {
    name: 'LlmRerank',
    async run(ctx, state) {
      // Effective enable: env default with per-query override.
      // query.rerank explicitly true → always run (even if env disabled).
      // query.rerank explicitly false → always skip.
      // query.rerank undefined → follow env flag.
      const enabled = ctx.query.rerank ?? ctx.config.rerank.enabled;
      if (!enabled) return state;
      if (typeof llm.rerank !== 'function') return state;
      if (state.facts.size === 0) return state;

      const rerankFn = llm.rerank;

      // Pre-rerank order by blendedScore.
      const sorted = Array.from(state.facts.values()).sort(
        (a, b) => (b.blendedScore ?? 0) - (a.blendedScore ?? 0),
      );

      let topK = Math.min(ctx.config.rerank.topK, sorted.length);
      if (topK === 0) return state;

      // Estimate prompt size. If above budget, halve topK.
      const queryTokens = await llm.countTokens(ctx.query.q);
      const sampleContent = sorted
        .slice(0, topK)
        .map((c) => c.fact.content.slice(0, CANDIDATE_CONTENT_CHARS))
        .join('\n');
      const estimate = queryTokens + (await llm.countTokens(sampleContent));
      if (estimate > llm.maxContextTokens * PROMPT_BUDGET_RATIO) {
        topK = Math.max(1, Math.floor(topK / 2));
      }

      const slice = sorted.slice(0, topK);
      const candidates = slice.map((c) => ({
        id: c.fact.id,
        content: c.fact.content.slice(0, CANDIDATE_CONTENT_CHARS),
      }));

      const result = await rerankFn({
        query: ctx.query.q,
        candidates,
        keepTopK: Math.min(ctx.config.rerank.keepK, slice.length),
      });

      // Map id → candidate for quick lookup.
      const candidateById = new Map<string, FactCandidate>(slice.map((c) => [c.fact.id, c]));

      // Fresh rank assignment based on rerank output.
      result.forEach((r, newRank) => {
        const candidate = candidateById.get(r.id);
        if (!candidate) return;
        candidate.rerankScore = r.score;

        const oldRank = slice.findIndex((s) => s.fact.id === r.id);
        if (newRank < oldRank) {
          candidate.expansionReason = 'rerank';
        }
      });

      return state;
    },
  };
}
