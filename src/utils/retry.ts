// Shared backoff for the two work queues that retry: the dream cycle over
// episodes, and the extraction worker over attachments. Both stamp a
// next-attempt time on the row rather than holding a timer, so a restart
// resumes the schedule instead of retrying everything at once.

export interface BackoffOptions {
  /** Attempts to allow in total. The last failure schedules nothing. */
  maxAttempts: number;
  /** Delay after the first failure; doubles from there. */
  baseMs: number;
  /** Ceiling, so a long-lived backlog still drains rather than backing off
   *  into next week. */
  capMs?: number;
  /** Injectable clock; defaults to now. */
  now?: () => number;
}

const DEFAULT_CAP_MS = 6 * 60 * 60_000;

/**
 * When to try again after a failure, or null when the attempt that just failed
 * was the last one — the caller reads null as "dead-letter this".
 */
export function nextRetryAt(priorAttempts: number, opts: BackoffOptions): Date | null {
  if (priorAttempts + 1 >= opts.maxAttempts) return null;
  const delay = opts.baseMs * 2 ** priorAttempts;
  const now = opts.now?.() ?? Date.now();
  return new Date(now + Math.min(delay, opts.capMs ?? DEFAULT_CAP_MS));
}
