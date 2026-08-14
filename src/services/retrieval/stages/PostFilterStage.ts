// Applies the query's hard filters pre-scoring so rerank and blending
// don't waste cycles on rows that would be dropped anyway.
//
// All four axes go through one rule, axisAllows: 'filter' excludes only
// cross-scope rows (a null/absent value is a shared global and passes),
// 'strict' additionally excludes nulls. Categories that don't carry an
// agent/session prop at all (preferences, insights, procedures, chunks, …)
// are therefore SHARED under agent/session 'filter' and excluded under
// 'strict' — they used to be wiped wholesale under 'filter', which silently
// emptied every preference from a per-agent recall.
//
// v1.2: also enforces `kinds` filtering (drop categories not asked for)
// and `projectScope`/`userScope` hard filters on every memory item that
// carries those props.

import type { MemoryKind, ScopeMode } from '../../../models/types.ts';
import { coversAsOf, isRedacted } from '../../../utils/temporal.ts';
import type { FactCandidate, PipelineState, RecallQuery, RetrievalStage } from '../types.ts';
import { recallAsOf } from './helpers.ts';

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
      const asOf = recallAsOf(ctx);

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
          // Redaction is absolute and the source queries already enforce it.
          // Repeated here because the expansion stages (entity_sibling,
          // chunk_derived, entity_ppr) build candidates through their own
          // queries — belt and braces on the one rule that must never leak.
          if (isRedacted(c.fact)) continue;
          if (minImp !== undefined && c.fact.importance < minImp) continue;
          if (minConf !== undefined && c.fact.confidence < minConf) continue;
          // Valid-time as-of (default now when not includeSuperseded).
          if (asOf && !coversAsOf(asOf, c.fact.validFrom, c.fact.validTo)) continue;
          // Optional range window: fact interval must overlap [from, to].
          if (fromT !== undefined && c.fact.validTo && c.fact.validTo.getTime() <= fromT) continue;
          if (toT !== undefined && c.fact.validFrom.getTime() > toT) continue;
          if (entityId !== undefined && !c.fact.entityIds.includes(entityId)) continue;

          // Facts take agent/session from origin lineage (stamped by
          // AgentOriginAnnotationStage, which already falls back to the
          // fact's own props for direct writes) — not from scopeMatches,
          // which would read the raw props and double-judge the axis.
          if (!axisAllows(c.originAgentId, q.agentId, agentScope)) continue;
          if (!axisAllows(c.originSessionId, q.sessionId, sessionScope)) continue;
          if (!axisAllows(c.fact.projectId, q.projectId, projectScope)) continue;
          if (!axisAllows(c.fact.userId, q.userId, userScope)) continue;
          factsOut.set(id, c);
        }
        state.facts = factsOut;
      }

      const filterArgs = { q, projectScope, userScope, agentScope, sessionScope, kinds: kindSet };
      // Raw episode chunks carry scope too; enforce it so a sandboxed reader
      // can't recover personal content from another scope's transcript.
      filterByScope(state.chunks, (c) => c.chunk, 'chunk', filterArgs);
      filterByScope(state.preferences, (c) => c.preference, 'preference', filterArgs);
      filterByScope(state.insights, (c) => c.insight, 'insight', filterArgs);
      filterByScope(state.knowledgeChunks, (c) => c.chunk, 'knowledge_chunk', filterArgs);
      filterByScope(state.procedures, (c) => c.procedure, 'procedure', filterArgs);
      filterByScope(state.research, (c) => c.research, 'research', filterArgs);
      filterByScope(state.researchChunks, (c) => c.chunk, 'research_chunk', filterArgs);
      filterByScope(state.observations, (c) => c.observation, 'observation', filterArgs);

      // If kinds filter excludes chunk context, drop it.
      if (kindSet && !kindSet.has('chunk')) state.chunks.clear();

      // Preferences are bi-temporal too: hold them to the same as-of instant as
      // facts, or a historical recall answers with today's values.
      if (asOf) {
        for (const [id, c] of state.preferences) {
          if (!coversAsOf(asOf, c.preference.validFrom, c.preference.validTo)) {
            state.preferences.delete(id);
          }
        }
      }

      return state;
    },
  };
}

interface ScopedItem {
  projectId?: string | null;
  userId?: string | null;
  // Only observations (and fact origin lineage, handled in the facts loop)
  // carry these; on every other category they are absent and axisAllows
  // treats absent as a shared global.
  agentId?: string | null;
  sessionId?: string | null;
}

interface FilterArgs {
  q: RecallQuery;
  projectScope: ScopeMode;
  userScope: ScopeMode;
  agentScope: ScopeMode;
  sessionScope: ScopeMode;
  kinds: Set<MemoryKind> | null;
}

function filterByScope<TKey, TCandidate>(
  map: Map<TKey, TCandidate>,
  pick: (c: TCandidate) => ScopedItem,
  kind: MemoryKind,
  args: FilterArgs,
): void {
  if (args.kinds && !args.kinds.has(kind)) {
    map.clear();
    return;
  }
  for (const [k, c] of map.entries()) {
    if (!scopeMatches(pick(c), args)) {
      map.delete(k);
    }
  }
}

function scopeMatches(
  item: ScopedItem,
  { q, projectScope, userScope, agentScope, sessionScope }: FilterArgs,
): boolean {
  return (
    axisAllows(item.projectId, q.projectId, projectScope) &&
    axisAllows(item.userId, q.userId, userScope) &&
    axisAllows(item.agentId, q.agentId, agentScope) &&
    axisAllows(item.sessionId, q.sessionId, sessionScope)
  );
}

// Decide whether a single scope axis admits an item. One rule for all four.
// 'filter' excludes only cross-scope items (nulls are shared globals);
// 'strict' additionally excludes nulls, so a sandboxed reader sees only
// items carrying its own scope value. Any other mode (or no query value)
// admits everything on this axis.
//
// Exported so the unit suite can assert this and scopeFilterClause (the Cypher
// expression of the same rule) agree over one table of inputs — they diverged
// before, with the pushdown excluding nulls under 'filter' and emitting
// nothing at all under 'strict'.
export function axisAllows(
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
