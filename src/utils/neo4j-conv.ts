import neo4j, { type DateTime } from 'neo4j-driver';

// Cypher param helpers ------------------------------------------------------
//
// We pass ISO-8601 strings into Cypher and wrap them with `datetime($x)` in the
// query. This keeps params plainly serialisable and avoids depending on the
// driver's native temporal types at the call site.

export function dateParam(d: Date): string {
  return d.toISOString();
}

export function nullableDateParam(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// Result reading helpers ----------------------------------------------------

export function toJsDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toStandardDate' in value) {
    return (value as DateTime).toStandardDate();
  }
  if (typeof value === 'string') return new Date(value);
  throw new Error(`Cannot convert value to Date: ${JSON.stringify(value)}`);
}

export function toJsDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return toJsDate(value);
}

// Re-export the driver namespace for any caller that needs the raw types.
export { neo4j };
