// Summarization that respects the LLM's context window, shared by the two
// callers that need it: ingestion (when it summarizes inline) and the dream
// cycle's pass that replaces the clipped-head summaries ingestion leaves behind.

import type { LLMAdapter } from '../adapters/llm/types.ts';
import { createChunker } from './Chunker.ts';

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
      `[summarize] map-reduce did not converge after ${SUMMARY_MAX_ROUNDS} rounds; truncating input`,
    );
    return llm.summarize({ text: current.slice(0, inputBudget * 4), targetTokens });
  };
}
