// Blends the rank-based fused score with explicit signals (importance,
// confidence, recency decay, reference count) into a single `blendedScore`.
// Then applies multiplicative boosts for same-agent / same-session origins
// and damps for expanded candidates (sibling / chunk-derived without a
// direct hit).
//
// Preferences and Insights use the same shape but with missing signal
// weights redistributed pro-rata onto the rrf term — they don't carry
// importance/refCount, and Insights don't carry confidence.

import { scopeBoostMultiplier } from '../../../repositories/scope.ts';
import { recencyScore, referenceScore } from '../../../utils/scoring.ts';
import type { ScoringWeights } from '../config.ts';
import type {
  FactCandidate,
  InsightCandidate,
  IntentionCandidate,
  KnowledgeChunkCandidate,
  PreferenceCandidate,
  ProcedureCandidate,
  ResearchCandidate,
  RetrievalContext,
  RetrievalStage,
} from '../types.ts';
import { buildRetrievalScope } from './scope-helpers.ts';

// Damps applied to candidates that didn't match the query directly.
const SIBLING_DAMPING = 0.5;
const CHUNK_DERIVED_DAMPING = 0.8;

// Scope-boost weights for project/user (agent/session boosts are handled
// inline on facts via origin lineage, so they're 1.0 here).
const SCOPE_BOOST_WEIGHTS = { project: 1.2, user: 1.1, agent: 1, session: 1 };

export function BlendedScoringStage(): RetrievalStage {
  return {
    name: 'BlendedScoring',
    async run(ctx, state) {
      const w = ctx.config.weights;
      const half = ctx.config.halfLifeDays;
      const boosts = ctx.config.boosts;
      const retrievalScope = buildRetrievalScope(ctx.query);
      const boostFor = (item: { projectId?: string | null; userId?: string | null }): number =>
        scopeBoostMultiplier(item, retrievalScope, SCOPE_BOOST_WEIGHTS);

      const maxFact = maxFused(state.facts.values());
      for (const c of state.facts.values()) {
        c.blendedScore = factBlend(c, ctx, w, half, maxFact, boosts) * boostFor(c.fact);
      }

      const maxPref = maxFused(state.preferences.values());
      for (const p of state.preferences.values()) {
        p.blendedScore = preferenceBlend(p, ctx.now, w, half, maxPref) * boostFor(p.preference);
      }

      const maxInsight = maxFused(state.insights.values());
      for (const i of state.insights.values()) {
        i.blendedScore = insightBlend(i, ctx.now, w, half, maxInsight) * boostFor(i.insight);
      }

      // Chunks: keep simple, they are context — rank purely by fused score.
      for (const c of state.chunks.values()) {
        c.blendedScore = c.fusedScore ?? 0;
      }

      // v1.2 categories — same shape as preferences/insights with scope boosts.
      const maxKnowledge = maxFused(state.knowledgeChunks.values());
      for (const c of state.knowledgeChunks.values()) {
        c.blendedScore = knowledgeBlend(c, ctx.now, w, half, maxKnowledge) * boostFor(c.chunk);
      }

      const maxProc = maxFused(state.procedures.values());
      for (const p of state.procedures.values()) {
        p.blendedScore = procedureBlend(p, ctx.now, w, half, maxProc) * boostFor(p.procedure);
      }

      const maxResearch = maxFused(state.research.values());
      for (const r of state.research.values()) {
        r.blendedScore = researchBlend(r, ctx.now, w, half, maxResearch) * boostFor(r.research);
      }

      const maxIntention = maxFused(state.intentions.values());
      for (const i of state.intentions.values()) {
        i.blendedScore = intentionBlend(i, ctx.now, w, half, maxIntention) * boostFor(i.intention);
      }

      return state;
    },
  };
}

function maxFused(iter: Iterable<{ fusedScore?: number }>): number {
  let m = 0;
  for (const c of iter) if ((c.fusedScore ?? 0) > m) m = c.fusedScore ?? 0;
  return m;
}

function normalisedRrf(fusedScore: number | undefined, maxFused: number): number {
  return maxFused > 0 ? (fusedScore ?? 0) / maxFused : 0;
}

function factBlend(
  c: FactCandidate,
  ctx: RetrievalContext,
  w: ScoringWeights,
  halfLife: number,
  maxFused: number,
  boosts: { ownAgent: number; sameSession: number },
): number {
  const rrf = normalisedRrf(c.fusedScore, maxFused);
  const rec = recencyScore(c.fact.recordedAt, ctx.now, halfLife);
  const ref = referenceScore(c.fact.referenceCount ?? 0);
  let blended =
    w.rrf * rrf +
    w.importance * c.fact.importance +
    w.confidence * c.fact.confidence +
    w.recency * rec +
    w.refCount * ref;

  if (c.expansionReason === 'entity_sibling') blended *= SIBLING_DAMPING;
  else if (c.expansionReason === 'chunk_derived' && !c.hasDirectHit) {
    blended *= CHUNK_DERIVED_DAMPING;
  } else if (c.expansionReason === 'entity_ppr' && !c.hasDirectHit) {
    // Pure graph-reachable facts (no direct vector/FT hit) are damped so they
    // supplement rather than outrank direct matches.
    blended *= ctx.config.ppr.blendDamp;
  }

  if (ctx.query.agentId && c.originAgentId === ctx.query.agentId) {
    blended *= boosts.ownAgent;
  }
  if (ctx.query.sessionId && c.originSessionId === ctx.query.sessionId) {
    blended *= boosts.sameSession;
  }
  // Project/user scope boosts are applied by the caller (see BlendedScoringStage).
  return blended;
}

// Preferences have confidence but no importance/refCount — redistribute those
// weights onto rrf so the scale stays comparable. Recency uses validFrom.
function preferenceBlend(
  c: PreferenceCandidate,
  now: Date,
  w: ScoringWeights,
  halfLife: number,
  maxFused: number,
): number {
  const rrfW = w.rrf + w.importance + w.refCount;
  const rrf = normalisedRrf(c.fusedScore, maxFused);
  const rec = recencyScore(c.preference.validFrom, now, halfLife);
  return rrfW * rrf + w.confidence * c.preference.confidence + w.recency * rec;
}

// Insights have only rrf + recency (via createdAt). Redistribute all other
// weights onto rrf.
function insightBlend(
  c: InsightCandidate,
  now: Date,
  w: ScoringWeights,
  halfLife: number,
  maxFused: number,
): number {
  return rrfPlusRecency(c.fusedScore, maxFused, c.insight.createdAt, now, halfLife, w);
}

// Knowledge chunks are pure context, like Episode chunks — primarily
// rrf-driven, with a mild recency tilt towards freshly-ingested content.
function knowledgeBlend(
  c: KnowledgeChunkCandidate,
  now: Date,
  w: ScoringWeights,
  halfLife: number,
  maxFused: number,
): number {
  return rrfPlusRecency(c.fusedScore, maxFused, c.chunk.createdAt, now, halfLife, w);
}

// Procedures: fold successRate into the importance slot — a procedure that
// usually works should outrank a peer that doesn't.
function procedureBlend(
  c: ProcedureCandidate,
  now: Date,
  w: ScoringWeights,
  halfLife: number,
  maxFused: number,
): number {
  const rrfW = w.rrf + w.confidence + w.refCount;
  const rrf = normalisedRrf(c.fusedScore, maxFused);
  const rec = recencyScore(c.procedure.updatedAt, now, halfLife);
  return rrfW * rrf + w.importance * c.procedure.successRate + w.recency * rec;
}

// Research: same shape as KnowledgeDocument, scored by summary embedding.
function researchBlend(
  c: ResearchCandidate,
  now: Date,
  w: ScoringWeights,
  halfLife: number,
  maxFused: number,
): number {
  return rrfPlusRecency(c.fusedScore, maxFused, c.research.updatedAt, now, halfLife, w);
}

// Intentions: rrf + recency (on createdAt). Single-source like research.
function intentionBlend(
  c: IntentionCandidate,
  now: Date,
  w: ScoringWeights,
  halfLife: number,
  maxFused: number,
): number {
  return rrfPlusRecency(c.fusedScore, maxFused, c.intention.createdAt, now, halfLife, w);
}

// Shared blend for "rrf + recency only" categories (insights, knowledge chunks,
// research). All non-rrf/recency weights are folded onto the rrf term so the
// total weight stays stable across categories that don't carry those signals.
function rrfPlusRecency(
  fusedScore: number | undefined,
  maxFused: number,
  recencyAt: Date,
  now: Date,
  halfLife: number,
  w: ScoringWeights,
): number {
  const rrfW = w.rrf + w.importance + w.confidence + w.refCount;
  const rrf = normalisedRrf(fusedScore, maxFused);
  const rec = recencyScore(recencyAt, now, halfLife);
  return rrfW * rrf + w.recency * rec;
}
