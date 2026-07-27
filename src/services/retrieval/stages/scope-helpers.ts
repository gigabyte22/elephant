// Pipeline-side helpers that translate a RecallQuery's scope axes into a
// repository-level RetrievalScope shape. Keeps the source stages focused
// on the repo call rather than scope translation.

import type { RetrievalScope, ScopeAxis } from '../../../repositories/scope.ts';
import type { RecallQuery } from '../types.ts';

// Which scope axes a node type actually carries. Pushing an axis at a label
// that lacks it emits `node.sessionId = $v` against, say, a :Procedure — which
// matches nothing and silently returns an empty result. Only :Intention (and
// the episode-derived kinds) carry the agent/session axes; every other
// :MemoryItem has just the two cross-cutting ones.
export const PROJECT_USER_AXES: readonly ScopeAxis[] = ['projectId', 'userId'];
export const ALL_SCOPE_AXES: readonly ScopeAxis[] = ['projectId', 'userId', 'agentId', 'sessionId'];

export function buildRetrievalScope(
  query: RecallQuery,
  axes: readonly ScopeAxis[] = ALL_SCOPE_AXES,
): RetrievalScope {
  const out: RetrievalScope = {};
  if (axes.includes('projectId')) {
    out.projectId = query.projectId;
    out.projectScope = query.projectScope;
  }
  if (axes.includes('userId')) {
    out.userId = query.userId;
    out.userScope = query.userScope;
  }
  if (axes.includes('agentId')) {
    out.agentId = query.agentId;
    out.agentScope = query.agentScope;
  }
  if (axes.includes('sessionId')) {
    out.sessionId = query.sessionId;
    out.sessionScope = query.sessionScope;
  }
  return out;
}
