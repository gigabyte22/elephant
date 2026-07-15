import { describe, expect, test } from 'vitest';
import { ebbinghausRetention, shouldPrune } from '../../src/utils/decay.ts';

describe('ebbinghausRetention', () => {
  test('decreases with days since last reference', () => {
    const at = (days: number) =>
      ebbinghausRetention({ daysSinceLastReference: days, referenceCount: 0, importance: 0.5 });
    expect(at(0)).toBe(1);
    expect(at(10)).toBeGreaterThan(at(30));
    expect(at(30)).toBeGreaterThan(at(90));
  });

  test('increases with reference count (spaced repetition rescue)', () => {
    const withRefs = (refs: number) =>
      ebbinghausRetention({ daysSinceLastReference: 60, referenceCount: refs, importance: 0.3 });
    expect(withRefs(0)).toBeLessThan(withRefs(3));
    expect(withRefs(3)).toBeLessThan(withRefs(10));
  });

  test('increases with importance', () => {
    const withImp = (imp: number) =>
      ebbinghausRetention({ daysSinceLastReference: 60, referenceCount: 0, importance: imp });
    expect(withImp(0.1)).toBeLessThan(withImp(0.5));
    expect(withImp(0.5)).toBeLessThan(withImp(0.7));
  });

  test('importance defaults to 0.5', () => {
    expect(ebbinghausRetention({ daysSinceLastReference: 45, referenceCount: 1 })).toBe(
      ebbinghausRetention({ daysSinceLastReference: 45, referenceCount: 1, importance: 0.5 }),
    );
  });
});

describe('shouldPrune', () => {
  test('importance at or above the exemption never prunes, at any age', () => {
    for (const days of [31, 365, 10_000]) {
      expect(
        shouldPrune({ importance: 0.75, daysSinceLastReference: days, referenceCount: 0 }),
      ).toBe(false);
      expect(
        shouldPrune({ importance: 0.9, daysSinceLastReference: days, referenceCount: 0 }),
      ).toBe(false);
    }
  });

  test('mid-importance facts DO prune once stale (the pre-fix regression)', () => {
    // importance 0.5, refs 0 → strength 3 → retention at 40d ≈ e^-13 << 0.05.
    expect(shouldPrune({ importance: 0.5, daysSinceLastReference: 40, referenceCount: 0 })).toBe(
      true,
    );
    // importance 0.3 telemetry-grade facts prune too.
    expect(shouldPrune({ importance: 0.3, daysSinceLastReference: 40, referenceCount: 0 })).toBe(
      true,
    );
  });

  test('window floor: never prunes within minWindowDays regardless of importance', () => {
    expect(shouldPrune({ importance: 0.0, daysSinceLastReference: 29, referenceCount: 0 })).toBe(
      false,
    );
  });

  test('reference count rescues a low-importance fact', () => {
    // importance 0.3, refs 10 → strength 21 * 2.2 = 46.2 → retention at 60d ≈ 0.27.
    expect(shouldPrune({ importance: 0.3, daysSinceLastReference: 60, referenceCount: 10 })).toBe(
      false,
    );
    // Same fact, unreferenced, prunes.
    expect(shouldPrune({ importance: 0.3, daysSinceLastReference: 60, referenceCount: 0 })).toBe(
      true,
    );
  });

  test('importance 0.6 with a few references survives ~71 days, then prunes', () => {
    const fact = { importance: 0.6, referenceCount: 3 };
    expect(shouldPrune({ ...fact, daysSinceLastReference: 65 })).toBe(false);
    expect(shouldPrune({ ...fact, daysSinceLastReference: 80 })).toBe(true);
  });

  test('config knobs override the defaults', () => {
    const base = { importance: 0.5, daysSinceLastReference: 40, referenceCount: 0 };
    expect(shouldPrune(base)).toBe(true);
    expect(shouldPrune({ ...base, config: { importanceExempt: 0.4 } })).toBe(false);
    expect(shouldPrune({ ...base, config: { minWindowDays: 60 } })).toBe(false);
    expect(shouldPrune({ ...base, config: { retentionFloor: 0.000001 } })).toBe(false);
  });
});
