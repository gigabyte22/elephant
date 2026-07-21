import { describe, expect, test } from 'vitest';
import { approxTokens, fitToTokenBudget } from '../../src/utils/tokens.ts';

const countTokens = async (t: string) => approxTokens(t);

describe('fitToTokenBudget', () => {
  test('text within budget is returned unchanged', async () => {
    const text = 'short and sweet';
    expect(await fitToTokenBudget(text, 100, countTokens)).toBe(text);
  });

  test('oversized text → prefix of the input within budget', async () => {
    const text = 'alpha beta gamma delta '.repeat(50);
    const budget = 20;
    const out = await fitToTokenBudget(text, budget, countTokens);
    expect(text.startsWith(out)).toBe(true);
    expect(await countTokens(out)).toBeLessThanOrEqual(budget);
    expect(out.length).toBeGreaterThan(0);
  });

  test('result does not end mid-word', async () => {
    const text = 'one two three four five six seven eight nine ten '.repeat(20);
    const out = await fitToTokenBudget(text, 10, countTokens);
    // The prefix ends exactly at a word from the input, not inside one.
    expect(text.startsWith(`${out} `)).toBe(true);
  });

  test('empty text or non-positive budget → empty string', async () => {
    expect(await fitToTokenBudget('', 10, countTokens)).toBe('');
    expect(await fitToTokenBudget('hello', 0, countTokens)).toBe('');
    expect(await fitToTokenBudget('hello', -1, countTokens)).toBe('');
  });

  test('unbroken text without whitespace still returns a bounded prefix', async () => {
    const text = 'x'.repeat(1000);
    const budget = 25;
    const out = await fitToTokenBudget(text, budget, countTokens);
    expect(text.startsWith(out)).toBe(true);
    expect(await countTokens(out)).toBeLessThanOrEqual(budget);
    expect(out.length).toBeGreaterThan(0);
  });

  test('combined whenToUse + content: prefix keeps whenToUse intact', async () => {
    const when = 'Use when the user asks for a weekly report.';
    const content = 'step one, do the thing. '.repeat(100);
    const budget = 50;
    expect(await countTokens(when)).toBeLessThanOrEqual(budget);
    const out = await fitToTokenBudget(`${when}\n\n${content}`, budget, countTokens);
    expect(out.startsWith(when)).toBe(true);
    expect(await countTokens(out)).toBeLessThanOrEqual(budget);
  });
});
