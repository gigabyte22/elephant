// Applies the query's hard filters pre-scoring so rerank and blending
// don't waste cycles on rows that would be dropped anyway.
// Also enforces agent/session scope when agentScope='filter' /
// sessionScope='filter' — null-origin facts (direct /facts POSTs) are
// preserved as shared content even under a filter, matching the isolation
// model's stance that facts themselves are global.
//
// v1.2: also enforces `kinds` filtering (drop categories not asked for)
// and `projectScope`/`userScope` hard filters on every memory item that
// carries those props.

import type { MemoryKind, ScopeMode } from '../../../models/types.ts';
import type { FactCandidate, PipelineState, RecallQuery, RetrievalStage } from '../types.ts';

export function PostFilterStage(): RetrievalStage {
  return {
    name: 'PostFilter',
    async run(ctx, state) {
      const q = ctx.query;
      const minImp = q.minImportance;
      const minConf = q.minConfidence;
      const fromT = q.from?.getTime();
      const toT = q.to?.getTime();
      const entityId = q.entityId;

      const agentScope = effectiveScope(q.agentScope, q.agentId);
      const sessionScope = effectiveScope(q.sessionScope, q.sessionId);
      const projectScope = effectiveScope(q.projectScope, q.projectId);
      const userScope = effectiveScope(q.userScope, q.userId);
      const kindSet = q.kinds && q.kinds.length > 0 ? new Set<MemoryKind>(q.kinds) : null;

      // Facts are special: drop the whole map if `kinds` excludes them, then
      // run row-level filters that combine the v1.1 importance/confidence/time/
      // entity gates with the v1.2 scope filters.
      if (kindSet && !kindSet.has('fact')) {
        state.facts = new Map();
      } else {
        const factsOut = new Map<string, FactCandidate>();
        for (const [id, c] of state.facts.entries()) {
          if (minImp !== undefined && c.fact.importance < minImp) continue;
          if (minConf !== undefined && c.fact.confidence < minConf) continue;
          if (fromT !== undefined && c.fact.validTo && c.fact.validTo.getTime() <= fromT) continue;
          if (toT !== undefined && c.fact.validFrom.getTime() > toT) continue;
          if (entityId !== undefined && !c.fact.entityIds.includes(entityId)) continue;

          if (agentScope === 'filter' && q.agentId) {
            if (c.originAgentId != null && c.originAgentId !== q.agentId) continue;
          }
          if (sessionScope === 'filter' && q.sessionId) {
            if (c.originSessionId != null && c.originSessionId !== q.sessionId) continue;
          }
          if (!scopeMatches(c.fact, q, projectScope, userScope)) continue;
          factsOut.set(id, c);
        }
        state.facts = factsOut;
      }

      // Categories with no per-record origin lineage drop entirely under
      // agent='filter' (preserving the pre-v1.2 contract). Project/user
      // 'filter' is row-level on each map.
      if (agentScope === 'filter' && q.agentId) {
        state.chunks.clear();
        state.preferences.clear();
        state.insights.clear();
        state.knowledgeChunks.clear();
        state.procedures.clear();
        state.research.clear();
        state.researchChunks.clear();
      }

      const filterArgs = { q, projectScope, userScope, kinds: kindSet };
      // Raw episode chunks carry scope too; enforce it so a sandboxed reader
      // can't recover personal content from another scope's transcript.
      filterByScope(state.chunks, (c) => c.chunk, 'chunk', filterArgs);
      filterByScope(state.preferences, (c) => c.preference, 'preference', filterArgs);
      filterByScope(state.insights, (c) => c.insight, 'insight', filterArgs);
      filterByScope(state.knowledgeChunks, (c) => c.chunk, 'knowledge_chunk', filterArgs);
      filterByScope(state.procedures, (c) => c.procedure, 'procedure', filterArgs);
      filterByScope(state.research, (c) => c.research, 'research', filterArgs);
      filterByScope(state.researchChunks, (c) => c.chunk, 'research_chunk', filterArgs);

      // If kinds filter excludes chunk context, drop it.
      if (kindSet && !kindSet.has('chunk')) state.chunks.clear();

      return state;
    },
  };
}

interface FilterArgs {
  q: RecallQuery;
  projectScope: ScopeMode;
  userScope: ScopeMode;
  kinds: Set<MemoryKind> | null;
}

function filterByScope<TKey, TCandidate>(
  map: Map<TKey, TCandidate>,
  pick: (c: TCandidate) => { projectId?: string | null; userId?: string | null },
  kind: MemoryKind,
  { q, projectScope, userScope, kinds }: FilterArgs,
): void {
  if (kinds && !kinds.has(kind)) {
    map.clear();
    return;
  }
  for (const [k, c] of map.entries()) {
    if (!scopeMatches(pick(c), q, projectScope, userScope)) {
      map.delete(k);
    }
  }
}

function scopeMatches(
  item: { projectId?: string | null; userId?: string | null },
  q: RecallQuery,
  projectScope: ScopeMode,
  userScope: ScopeMode,
): boolean {
  return (
    axisAllows(item.projectId, q.projectId, projectScope) &&
    axisAllows(item.userId, q.userId, userScope)
  );
}

// Decide whether a single scope axis (project or user) admits an item.
// 'filter' excludes only cross-scope items (nulls are shared globals);
// 'strict' additionally excludes nulls, so a sandboxed reader sees only
// items carrying its own scope value. Any other mode (or no query value)
// admits everything on this axis.
function axisAllows(
  itemValue: string | null | undefined,
  queryValue: string | undefined,
  mode: ScopeMode,
): boolean {
  if ((mode !== 'filter' && mode !== 'strict') || !queryValue) return true;
  if (mode === 'strict' && itemValue == null) return false;
  return itemValue == null || itemValue === queryValue;
}

function effectiveScope(explicit: ScopeMode | undefined, value: string | undefined): ScopeMode {
  if (!value) return 'none';
  return explicit ?? 'boost';
}

// Re-export PipelineState typing so the test suite can import the shape from
// the stage that owns the filter logic.
export type { PipelineState };
