import { describe, expect, test } from 'vitest';
import { cosine } from '../../src/utils/cosine.ts';

describe('cosine', () => {
  test('identical vectors → 1', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });
  test('orthogonal vectors → 0', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
  test('opposite vectors → -1', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  test('zero vector → 0 (no NaN)', () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
  test('mismatched lengths → 0', () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });
});
