// Scope filter shape mirrors the API's ScopeQuery. Carried on the URL search
// string so deep links preserve the active filter, and read into a typed
// object by useScope().

export interface Scope {
  agentId?: string;
  sessionId?: string;
  projectId?: string;
  userId?: string;
}

const KEYS = ['agentId', 'sessionId', 'projectId', 'userId'] as const;

export function parseScope(search: string): Scope {
  const params = new URLSearchParams(search);
  const out: Scope = {};
  for (const k of KEYS) {
    const v = params.get(k);
    if (v && v.length > 0) out[k] = v;
  }
  return out;
}

export function scopeToQueryString(scope: Scope, extra: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  for (const k of KEYS) {
    const v = scope[k];
    if (v) params.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function activeScopeAxes(scope: Scope): Array<{ key: keyof Scope; value: string }> {
  return KEYS.flatMap((k) => (scope[k] ? [{ key: k, value: scope[k]! }] : []));
}
