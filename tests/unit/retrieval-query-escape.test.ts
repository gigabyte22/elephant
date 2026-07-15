import { describe, expect, test } from 'vitest';
import { escapeLucene, expandQueryForFullText } from '../../src/services/retrieval/query/escape.ts';

describe('escapeLucene', () => {
  test('returns empty string for empty input', () => {
    expect(escapeLucene('')).toBe('');
  });

  test('passes plain alphanumerics unchanged (modulo whitespace normalization)', () => {
    expect(escapeLucene('hello world')).toBe('hello world');
    expect(escapeLucene('   hello   world   ')).toBe('hello world');
  });

  test.each([
    ['AI+ML', 'AI\\+ML'],
    ['(ts|tsx)', '\\(ts|tsx\\)'],
    ['user:dark-mode', 'user\\:dark\\-mode'],
    ['path/to/file', 'path\\/to\\/file'],
    ['"quoted"', '\\"quoted\\"'],
    ['wild*card', 'wild\\*card'],
    ['a && b', 'a \\&& b'],
    ['a || b', 'a \\|| b'],
    ['[bracket]', '\\[bracket\\]'],
    ['{curly}', '\\{curly\\}'],
  ])('escapes reserved chars in %j -> %j', (input, expected) => {
    expect(escapeLucene(input)).toBe(expected);
  });

  test('expandQueryForFullText matches escapeLucene today', () => {
    expect(expandQueryForFullText('AI+ML')).toBe(escapeLucene('AI+ML'));
  });
});
