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

/**
 * True when the claim's valid-time interval covers `asOf` (half-open: validFrom
 * ≤ asOf < validTo|∞). Used by hybrid recall and timeline-style filters.
 */
export function coversAsOf(asOf: Date, validFrom: Date, validTo: Date | null): boolean {
  if (validFrom.getTime() > asOf.getTime()) return false;
  if (validTo !== null && validTo.getTime() <= asOf.getTime()) return false;
  return true;
}

/**
 * Effective as-of for hybrid fact recall: explicit query.asOf wins; otherwise
 * default to "now" when we are not asking for superseded history. When
 * includeSuperseded is true and asOf is omitted, returns null (no interval
 * filter — legacy "show open + closed" source behavior).
 */
export function effectiveRecallAsOf(input: {
  asOf?: Date;
  now: Date;
  includeSuperseded?: boolean;
}): Date | null {
  if (input.asOf) return input.asOf;
  if (input.includeSuperseded) return null;
  return input.now;
}

/**
 * Cypher form of `coversAsOf`, spliced after an existing WHERE (same `AND …`
 * convention as `scopeFilterClause` in repositories/scope.ts). Kept beside the
 * in-memory predicate so the two expressions of one rule can't drift.
 *
 * Binds `$asOf`; callers pass `dateParam(asOf)` (or null when the clause is
 * empty — an unreferenced param is harmless).
 */
export function validAtClause(
  alias: string,
  input: {
    asOf: Date | null;
    includeSuperseded?: boolean;
  },
): string {
  if (input.asOf) {
    return `AND ${alias}.validFrom <= datetime($asOf)
            AND (${alias}.validTo IS NULL OR ${alias}.validTo > datetime($asOf))`;
  }
  return input.includeSuperseded ? '' : `AND ${alias}.validTo IS NULL`;
}
