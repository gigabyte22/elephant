// Shared helpers for scope-aware repo writes and retrieval-time filtering.
//
// Scope axes are: projectId, userId, agentId, sessionId. Each can run in one
// of three modes at retrieval time: 'filter' (hard match), 'boost' (multiplier
// on score), or 'none' (ignored). The default for every axis is 'boost' when a
// value is supplied, 'none' otherwise.
//
// Repository writes simply persist whichever scope props are supplied; the
// scoring/filter logic lives in retrieval pipeline stages.

import type { MemoryKind, Scope, ScopeMode } from '../models/types.ts';

export type ScopeAxis = 'projectId' | 'userId' | 'agentId' | 'sessionId';

export interface RetrievalScope {
  projectId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  projectScope?: ScopeMode;
  userScope?: ScopeMode;
  agentScope?: ScopeMode;
  sessionScope?: ScopeMode;
}

export interface ScopeBoostWeights {
  project: number;
  user: number;
  agent: number;
  session: number;
}

const AXES: Array<{
  axis: ScopeAxis;
  modeKey: keyof RetrievalScope;
  weightKey: keyof ScopeBoostWeights;
}> = [
  { axis: 'projectId', modeKey: 'projectScope', weightKey: 'project' },
  { axis: 'userId', modeKey: 'userScope', weightKey: 'user' },
  { axis: 'agentId', modeKey: 'agentScope', weightKey: 'agent' },
  { axis: 'sessionId', modeKey: 'sessionScope', weightKey: 'session' },
];

/**
 * Build a Cypher predicate fragment + params that hard-filter on every axis
 * whose mode is 'filter'. Returns an empty clause when no axis is filtering.
 *
 * Example: scopeFilterClause('node', { projectId: 'p1', projectScope: 'filter' })
 *  → { clause: "node.projectId = $scope_projectId", params: { scope_projectId: 'p1' } }
 */
export function scopeFilterClause(
  alias: string,
  scope: RetrievalScope,
): { clause: string; params: Record<string, string | null> } {
  const parts: string[] = [];
  const params: Record<string, string | null> = {};
  for (const { axis, modeKey } of AXES) {
    if (scope[modeKey] === 'filter' && scope[axis]) {
      const paramName = `scope_${axis}`;
      parts.push(`${alias}.${axis} = $${paramName}`);
      params[paramName] = scope[axis] ?? null;
    }
  }
  return {
    clause: parts.length ? parts.join(' AND ') : '',
    params,
  };
}

/**
 * Convenience wrappers around `scopeFilterClause` for the two splice points
 * that show up in repo queries:
 *   - `WHERE` form: prepended `WHERE …` when used after a MATCH with no other filters.
 *   - `AND` form: prepended `AND …` when spliced after an existing WHERE clause.
 *
 * Both return an empty string when no axis is filtering, so they can be
 * concatenated unconditionally into the Cypher template.
 */
export function scopeWhereClause(
  alias: string,
  scope: RetrievalScope = {},
): { clause: string; params: Record<string, string | null> } {
  const { clause, params } = scopeFilterClause(alias, scope);
  return { clause: clause ? `WHERE ${clause}` : '', params };
}

export function scopeAndClause(
  alias: string,
  scope: RetrievalScope = {},
): { clause: string; params: Record<string, string | null> } {
  const { clause, params } = scopeFilterClause(alias, scope);
  return { clause: clause ? `AND ${clause}` : '', params };
}

/**
 * Boost multiplier for a candidate node, based on which scope axes match the
 * caller's request when the corresponding mode is 'boost'.
 */
export function scopeBoostMultiplier(
  record: Partial<Record<ScopeAxis, string | null | undefined>>,
  scope: RetrievalScope,
  weights: ScopeBoostWeights,
): number {
  let mult = 1;
  for (const { axis, modeKey, weightKey } of AXES) {
    if (scope[modeKey] === 'boost' && scope[axis] && record[axis] === scope[axis]) {
      mult *= weights[weightKey];
    }
  }
  return mult;
}

/**
 * Cypher param object for scope writes. Resolves undefined to `null` so
 * `SET n.projectId = $projectId` is well-defined either way.
 */
export function scopeWriteParams(scope: Scope = {}): {
  projectId: string | null;
  userId: string | null;
} {
  return {
    projectId: scope.projectId ?? null,
    userId: scope.userId ?? null,
  };
}

/**
 * Read scope props off a Neo4j node row. Used by every `to*` mapper so all
 * memory items consistently surface their scope.
 */
export function readScope(node: Record<string, unknown>): Scope {
  const projectId = node.projectId as string | null | undefined;
  const userId = node.userId as string | null | undefined;
  const out: Scope = {};
  if (projectId) out.projectId = projectId;
  if (userId) out.userId = userId;
  return out;
}

/**
 * Cypher fragment for the `:MemoryItem` base label + `kind`/`projectId`/`userId`
 * properties. Keeps the SET clause consistent across every repo's write path.
 *
 * Returns the SET fragment to splice in *after* a node match/merge, e.g.:
 *   MERGE (f:Fact {id: $id})
 *   SET f:MemoryItem, f.kind = $kind, f.projectId = $projectId, f.userId = $userId
 */
export function memoryItemSetClause(alias: string): string {
  return `${alias}:MemoryItem, ${alias}.kind = $kind, ${alias}.projectId = $projectId, ${alias}.userId = $userId`;
}

export function memoryItemParams(
  kind: MemoryKind,
  scope: Scope = {},
): { kind: MemoryKind; projectId: string | null; userId: string | null } {
  return {
    kind,
    ...scopeWriteParams(scope),
  };
}
