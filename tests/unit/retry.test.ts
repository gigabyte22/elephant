import { describe, expect, it } from 'vitest';
import { nextRetryAt } from '../../src/utils/retry.ts';

const NOW = Date.UTC(2026, 0, 1);
const now = () => NOW;

describe('nextRetryAt', () => {
  it('doubles the delay with each prior attempt', () => {
    const opts = { maxAttempts: 5, baseMs: 1000, now };
    expect(nextRetryAt(0, opts)?.getTime()).toBe(NOW + 1000);
    expect(nextRetryAt(1, opts)?.getTime()).toBe(NOW + 2000);
    expect(nextRetryAt(2, opts)?.getTime()).toBe(NOW + 4000);
  });

  it('returns null on the attempt that exhausts the budget', () => {
    // The caller reads null as "dead-letter this" — there is no next attempt to
    // schedule, so the row must stop being claimable rather than sit pending
    // with a time that never comes.
    const opts = { maxAttempts: 3, baseMs: 1000, now };
    expect(nextRetryAt(1, opts)).not.toBeNull();
    expect(nextRetryAt(2, opts)).toBeNull();
    expect(nextRetryAt(9, opts)).toBeNull();
  });

  it('caps the delay so a long backlog still drains', () => {
    const opts = { maxAttempts: 50, baseMs: 60_000, capMs: 3600_000, now };
    expect(nextRetryAt(20, opts)?.getTime()).toBe(NOW + 3600_000);
  });

  it('treats maxAttempts of 1 as no retries at all', () => {
    expect(nextRetryAt(0, { maxAttempts: 1, baseMs: 1000, now })).toBeNull();
  });
});
