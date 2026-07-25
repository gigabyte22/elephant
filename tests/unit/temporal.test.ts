import { describe, expect, test } from 'vitest';
import {
  coversAsOf,
  effectiveRecallAsOf,
  eventValidTo,
  isValidInterval,
} from '../../src/utils/temporal.ts';

describe('eventValidTo', () => {
  test('uses new.validFrom when it is later', () => {
    const oldFrom = new Date('2024-01-01T00:00:00Z');
    const newFrom = new Date('2024-06-01T00:00:00Z');
    expect(eventValidTo(oldFrom, newFrom).toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  test('clamps to old.validFrom when new is earlier (out-of-order)', () => {
    const oldFrom = new Date('2024-06-01T00:00:00Z');
    const newFrom = new Date('2024-01-01T00:00:00Z');
    expect(eventValidTo(oldFrom, newFrom).toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  test('equal timestamps are fine', () => {
    const t = new Date('2024-03-15T12:00:00Z');
    expect(eventValidTo(t, t).getTime()).toBe(t.getTime());
  });
});

describe('isValidInterval', () => {
  test('open end is always valid', () => {
    expect(isValidInterval(new Date('2024-01-01'), null)).toBe(true);
  });

  test('end after start is valid', () => {
    expect(isValidInterval(new Date('2024-01-01'), new Date('2024-06-01'))).toBe(true);
  });

  test('end equal start is valid (zero-length / same-instant handoff)', () => {
    const t = new Date('2024-01-01');
    expect(isValidInterval(t, t)).toBe(true);
  });

  test('end before start is invalid', () => {
    expect(isValidInterval(new Date('2024-06-01'), new Date('2024-01-01'))).toBe(false);
  });
});

describe('coversAsOf', () => {
  const t1 = new Date('2024-01-01T00:00:00Z');
  const t2 = new Date('2024-06-01T00:00:00Z');
  const mid = new Date('2024-03-01T00:00:00Z');

  test('open interval covers after validFrom', () => {
    expect(coversAsOf(mid, t1, null)).toBe(true);
  });

  test('excludes before validFrom', () => {
    expect(coversAsOf(t1, mid, null)).toBe(false);
  });

  test('excludes at or after validTo (half-open)', () => {
    expect(coversAsOf(t2, t1, t2)).toBe(false);
    expect(coversAsOf(mid, t1, t2)).toBe(true);
  });
});

describe('effectiveRecallAsOf', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const past = new Date('2024-01-01T00:00:00Z');

  test('explicit asOf wins', () => {
    expect(effectiveRecallAsOf({ asOf: past, now, includeSuperseded: true })?.toISOString()).toBe(
      past.toISOString(),
    );
  });

  test('defaults to now when not includeSuperseded', () => {
    expect(effectiveRecallAsOf({ now, includeSuperseded: false })?.toISOString()).toBe(
      now.toISOString(),
    );
  });

  test('null when includeSuperseded and no asOf (legacy open+closed)', () => {
    expect(effectiveRecallAsOf({ now, includeSuperseded: true })).toBeNull();
  });
});
