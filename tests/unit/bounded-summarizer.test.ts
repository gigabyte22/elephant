import { describe, expect, test } from 'vitest';
import { createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { createBoundedSummarizer } from '../../src/services/MemoryIngestionService.ts';
import { approxTokens } from '../../src/utils/tokens.ts';

// maxContextTokens 1000 → input budget = 600 tokens (SUMMARY_CONTEXT_USABLE 0.6).
function makeLLM(calls: string[], opts: { maxContextTokens?: number } = {}) {
  return createFakeLLMAdapter({
    maxContextTokens: opts.maxContextTokens ?? 1_000,
    summarize: (input) => {
      calls.push(input.text);
      return `S(${approxTokens(input.text)}t)`;
    },
  });
}

describe('createBoundedSummarizer', () => {
  test('text under the input budget → single summarize call with the full text', async () => {
    const calls: string[] = [];
    const llm = makeLLM(calls);
    const summarize = createBoundedSummarizer(llm, 300);

    const text = 'short transcript';
    const out = await summarize(text, await llm.countTokens(text));

    expect(calls).toEqual([text]);
    expect(out).toMatch(/^S\(/);
  });

  test('oversized text → map-reduce: every summarize input fits the budget', async () => {
    const calls: string[] = [];
    const llm = makeLLM(calls);
    const summarize = createBoundedSummarizer(llm, 300);

    // ~3000 tokens against a 600-token input budget → must be chunked.
    const text = 'A sentence about the session under review. '.repeat(300);
    await summarize(text, await llm.countTokens(text));

    expect(calls.length).toBeGreaterThan(1);
    const budget = Math.floor(llm.maxContextTokens * 0.6);
    for (const input of calls) {
      expect(approxTokens(input)).toBeLessThanOrEqual(budget);
    }
    // Final reduce call is over joined partials, not raw transcript.
    expect(calls[calls.length - 1]).toContain('S(');
  });

  test('never converging input still terminates via truncation', async () => {
    const calls: string[] = [];
    // Summaries that are as big as their input: reduce rounds can't shrink it.
    const llm = createFakeLLMAdapter({
      maxContextTokens: 1_000,
      summarize: (input) => {
        calls.push(input.text);
        return input.text;
      },
    });
    const summarize = createBoundedSummarizer(llm, 300);

    const text = 'word '.repeat(5_000);
    const out = await summarize(text, await llm.countTokens(text));

    expect(out.length).toBeGreaterThan(0);
    // Last call was hard-truncated to ~budget*4 chars.
    expect(calls[calls.length - 1]!.length).toBeLessThanOrEqual(600 * 4);
  });
});
