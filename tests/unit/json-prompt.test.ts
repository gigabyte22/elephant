import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  ConsolidateResponseSchema,
  JsonExtractionError,
  extractJson,
  parseJsonResponse,
} from '../../src/adapters/llm/json-prompt.ts';

describe('extractJson', () => {
  test('plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  test('fenced JSON', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 });
  });
  test('JSON with trailing chatter', () => {
    expect(extractJson('{"a":1} -- and that is the answer')).toEqual({ a: 1 });
  });
  test('strips Qwen3.5 / DeepSeek-R1 <think> blocks before parsing', () => {
    const raw = '<think>\nThe user wants JSON.\n</think>\n\n{"a":1}';
    expect(extractJson(raw)).toEqual({ a: 1 });
  });
  test('handles thinking blocks containing brace-like syntax', () => {
    const raw =
      '<think>I should output { something like this } maybe?</think>\n{"facts":[{"content":"x","confidence":0.9,"importance":0.5,"entityNames":[]}]}';
    expect(extractJson(raw)).toEqual({
      facts: [{ content: 'x', confidence: 0.9, importance: 0.5, entityNames: [] }],
    });
  });
  test('throws when no JSON present', () => {
    expect(() => extractJson('no json here')).toThrow(JsonExtractionError);
  });
});

describe('parseJsonResponse', () => {
  test('validates against schema', () => {
    const schema = z.object({ n: z.number() });
    expect(parseJsonResponse('{"n":42}', schema)).toEqual({ n: 42 });
  });
  test('throws on schema mismatch', () => {
    const schema = z.object({ n: z.number() });
    expect(() => parseJsonResponse('{"n":"oops"}', schema)).toThrow(JsonExtractionError);
  });
});

describe('ConsolidateResponseSchema', () => {
  const idA = '9b2f5c1e-0a4d-4a8e-b1c2-3d4e5f6a7b8c';
  const idB = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';

  test('parses a merge decision wrapped in fences and think blocks', () => {
    const raw = `<think>merge them</think>\n\`\`\`json\n{"decision":"merge","mergeFactIds":["${idA}","${idB}"],"content":"The user's oldest daughter, Isabelle, is 6 years old.","confidence":0.9,"importance":0.85}\n\`\`\``;
    const parsed = parseJsonResponse(raw, ConsolidateResponseSchema);
    expect(parsed.decision).toBe('merge');
    expect(parsed.mergeFactIds).toEqual([idA, idB]);
  });

  test('tolerates bracket-wrapped ids', () => {
    const parsed = ConsolidateResponseSchema.parse({
      decision: 'merge',
      mergeFactIds: [`[${idA}]`, idB],
      content: 'merged',
      confidence: 0.8,
      importance: 0.5,
    });
    expect(parsed.mergeFactIds).toEqual([idA, idB]);
  });

  test('rejects non-uuid merge ids', () => {
    expect(() =>
      ConsolidateResponseSchema.parse({
        decision: 'merge',
        mergeFactIds: ['not-a-uuid'],
        content: 'merged',
        confidence: 0.8,
        importance: 0.5,
      }),
    ).toThrow();
  });

  test('keep decision defaults the optional fields', () => {
    const parsed = ConsolidateResponseSchema.parse({ decision: 'keep' });
    expect(parsed.mergeFactIds).toEqual([]);
    expect(parsed.content).toBe('');
  });
});
