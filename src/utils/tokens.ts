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

type CountTokens = (text: string) => Promise<number>;

// Longest prefix of `text` whose token count fits budgetTokens. Binary search
// on prefix length — O(log n) countTokens calls — assuming token count is
// monotone in prefix length (true for approxTokens and BPE/WordPiece
// tokenizers). Backs off to the previous whitespace boundary so the prefix
// doesn't end mid-word, unless that would give back more than ~8 tokens of
// budget (e.g. one enormous unbroken token).
export async function fitToTokenBudget(
  text: string,
  budgetTokens: number,
  countTokens: CountTokens,
): Promise<string> {
  if (budgetTokens <= 0 || !text) return '';
  if ((await countTokens(text)) <= budgetTokens) return text;
  let lo = 0; // longest prefix length known to fit (empty = 0 tokens)
  let hi = text.length; // shortest prefix length known not to fit
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((await countTokens(text.slice(0, mid))) <= budgetTokens) lo = mid;
    else hi = mid;
  }
  const cut = text.slice(0, lo);
  const ws = cut.search(/\s+\S*$/);
  if (ws > 0 && ws > lo - 8 * APPROX_CHARS_PER_TOKEN) return cut.slice(0, ws).trimEnd();
  return cut;
}
