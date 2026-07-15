// Pipeline-side helpers that translate a RecallQuery's scope axes into a
// repository-level RetrievalScope shape. Keeps the source stages focused
// on the repo call rather than scope translation.

import type { RetrievalScope } from '../../../repositories/scope.ts';
import type { RecallQuery } from '../types.ts';

export function buildRetrievalScope(query: RecallQuery): RetrievalScope {
  return {
    projectId: query.projectId,
    userId: query.userId,
    agentId: query.agentId,
    sessionId: query.sessionId,
    projectScope: query.projectScope,
    userScope: query.userScope,
    agentScope: query.agentScope,
    sessionScope: query.sessionScope,
  };
}
