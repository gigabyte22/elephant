import { describe, expect, test } from 'vitest';
import { reciprocalRankFusion } from '../../src/utils/rrf.ts';

describe('reciprocalRankFusion', () => {
  test('items in both lists rank higher than items in one', () => {
    const a = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    const b = [{ id: 'y' }, { id: 'w' }, { id: 'x' }];
    const fused = reciprocalRankFusion([a, b], (i) => i.id);
    expect(fused[0]?.key).toBe('y');
    // 'x' is in both; should rank above singletons.
    const order = fused.map((f) => f.key);
    expect(order.indexOf('x')).toBeLessThan(order.indexOf('z'));
    expect(order.indexOf('x')).toBeLessThan(order.indexOf('w'));
  });

  test('single empty list does not throw', () => {
    expect(reciprocalRankFusion<{ id: string }>([[]], (i) => i.id)).toEqual([]);
  });
});
