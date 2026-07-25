// Bi-temporal helpers: valid time (when a claim held in the world) vs
// transaction time (when Elephant wrote/decided). See SPEC.md.

/**
 * Event-time end of a superseded claim: max(old.validFrom, new.validFrom).
 * Never returns a timestamp before the old fact started, so we never write
 * an inverted valid interval even on out-of-order supersede.
 */
export function eventValidTo(oldValidFrom: Date, newValidFrom: Date): Date {
  return new Date(Math.max(oldValidFrom.getTime(), newValidFrom.getTime()));
}

/** True when [validFrom, validTo) is a well-formed closed-open interval (or open end). */
export function isValidInterval(validFrom: Date, validTo: Date | null): boolean {
  if (validTo === null) return true;
  return validTo.getTime() >= validFrom.getTime();
}
