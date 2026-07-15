// Token-count utilities. We don't ship a real tokenizer (tiktoken is ~500KB
// WASM; @xenova/transformers is bigger still) — instead adapters expose their
// own countTokens() so they can install an accurate tokenizer if they want,
// and the rest of the code uses that adapter method. This module is the safe
// fallback: a conservative char-ratio estimate that intentionally rounds up so
// we don't overshoot an embedder's real limit and trigger silent truncation.

// Empirically, English text through BPE/WordPiece is ~4 chars per token.
// Rounding up on ceil plus a 10% safety headroom in callers gives enough slack.
export const APPROX_CHARS_PER_TOKEN = 4;

export function approxTokens(text: string, charsPerToken: number = APPROX_CHARS_PER_TOKEN): number {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken);
}
