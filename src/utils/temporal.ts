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
 * Redaction gate.
 *
 * Three lifecycle events close a fact's valid interval, and only one of them
 * hides history:
 *
 *   supersede — the world changed at event time. Legitimate history.
 *   prune     — the claim held then; the system forgot it now. Also history.
 *   DELETE    — the record is redacted. Invisible at EVERY instant.
 *
 * `validTo` alone cannot express that difference, so redaction gets its own
 * property and this clause is emitted unconditionally by `validAtClause` —
 * including in the `includeSuperseded` branch, which used to return an empty
 * string and was exactly how a deleted fact came back via ?includeSuperseded=1
 * or any `asOf` before the deletion.
 *
 * Safe to splice against labels that have no `deletedAt` (preferences): a
 * missing property reads as NULL in Cypher, so the predicate is a no-op there.
 */
export function notDeletedClause(alias: string): string {
  return `AND ${alias}.deletedAt IS NULL`;
}

/**
 * In-memory twin of `notDeletedClause`, for the expansion paths that build
 * candidates outside the source queries. Kept adjacent for the same reason as
 * `coversAsOf`/`validAtClause`: two expressions of one rule must not drift.
 */
export function isRedacted(item: { deletedAt?: Date | null }): boolean {
  return item.deletedAt != null;
}

/**
 * Cypher form of `coversAsOf`, spliced after an existing WHERE (same `AND …`
 * convention as `scopeFilterClause` in repositories/scope.ts). Kept beside the
 * in-memory predicate so the two expressions of one rule can't drift.
 *
 * Binds `$asOf`; callers pass `dateParam(asOf)` (or null when the clause omits
 * it — an unreferenced param is harmless).
 *
 * NOTE: this never returns an empty string any more, because the redaction
 * gate is unconditional. Every call site must therefore have a preceding
 * predicate for the leading `AND` to attach to — all three do today.
 */
export function validAtClause(
  alias: string,
  input: {
    asOf: Date | null;
    includeSuperseded?: boolean;
  },
): string {
  const notDeleted = notDeletedClause(alias);
  if (input.asOf) {
    return `${notDeleted}
            AND ${alias}.validFrom <= datetime($asOf)
            AND (${alias}.validTo IS NULL OR ${alias}.validTo > datetime($asOf))`;
  }
  return input.includeSuperseded
    ? notDeleted
    : `${notDeleted}\n            AND ${alias}.validTo IS NULL`;
}
