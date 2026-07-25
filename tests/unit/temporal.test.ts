import { describe, expect, test } from 'vitest';
import { eventValidTo, isValidInterval } from '../../src/utils/temporal.ts';

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
