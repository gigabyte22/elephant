import { describe, expect, test } from 'vitest';
import { importance, recencyScore, referenceScore } from '../../src/utils/scoring.ts';

describe('scoring', () => {
  test('recency: now=1, ~30d=0.5, ~60d=0.25', () => {
    const now = new Date('2026-04-22T00:00:00Z');
    expect(recencyScore(now, now)).toBeCloseTo(1, 6);
    const d30 = new Date(now.getTime() - 30 * 86_400_000);
    expect(recencyScore(d30, now)).toBeCloseTo(0.5, 6);
    const d60 = new Date(now.getTime() - 60 * 86_400_000);
    expect(recencyScore(d60, now)).toBeCloseTo(0.25, 6);
  });

  test('referenceScore: 0 → 0, saturates near 1', () => {
    expect(referenceScore(0)).toBe(0);
    expect(referenceScore(10)).toBeCloseTo(1, 6);
    expect(referenceScore(100)).toBeCloseTo(1, 1);
    expect(referenceScore(100)).toBeLessThanOrEqual(1);
  });

  test('importance: weighted blend of recency, refs, explicit', () => {
    const now = new Date();
    const explicit = importance({
      recordedAt: now,
      referenceCount: 0,
      explicit: true,
      now,
    });
    // recency=1*0.4 + ref=0*0.3 + explicit=1*0.3 = 0.7
    expect(explicit).toBeCloseTo(0.7, 6);

    const stale = importance({
      recordedAt: new Date(now.getTime() - 90 * 86_400_000),
      referenceCount: 0,
      explicit: false,
      now,
    });
    // recency≈0.125, ref=0, explicit=0  → 0.05
    expect(stale).toBeLessThan(0.1);
  });
});
