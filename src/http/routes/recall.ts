import { z } from 'zod';
import type { Container } from '../../index.ts';
import { ScopeModeSchema } from '../../models/types.ts';
import {
  toWireChunk,
  toWireEntity,
  toWireFact,
  toWireInsight,
  toWireIntention,
  toWireKnowledgeChunk,
  toWireObservation,
  toWirePreference,
  toWireProcedure,
  toWireResearch,
  toWireResearchChunk,
} from '../../models/wire.ts';
import { badRequest } from '../errors.ts';
import type { App } from '../types.ts';
import {
  okEnvelope,
  queryBool,
  ScoreFields,
  WireChunkSchema,
  WireEntitySchema,
  WireFactWithScoreSchema,
  WireInsightWithScoreSchema,
  WireIntentionSchema,
  WireKnowledgeChunkSchema,
  WireMemoryKindSchema,
  WireObservationSchema,
  WirePreferenceWithScoreSchema,
  WireProcedureSchema,
  WireRecallTraceSchema,
  WireResearchChunkSchema,
  WireResearchSchema,
} from '../wire-schemas.ts';

// Comma-separated kinds in the URL → array.
const Kinds = z
  .union([
    z.string().transform((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    ),
    z.array(z.string()),
  ])
  .pipe(z.array(WireMemoryKindSchema));

const Query = z.object({
  q: z.string().min(1),
  agentId: z.string().min(1).optional(),
  sessionId: z.string().optional(),
  agentScope: ScopeModeSchema.optional(),
  sessionScope: ScopeModeSchema.optional(),
  // v1.2: cross-cutting scope axes.
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  projectScope: ScopeModeSchema.optional(),
  userScope: ScopeModeSchema.optional(),
  // v1.2: restrict search to specific memory kinds (comma-separated).
  kinds: Kinds.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // Valid-time as-of for fact interval filters (default: now when not
  // includeSuperseded). Distinct from GET /timeline, which returns a full
  // snapshot without hybrid ranking.
  asOf: z.coerce.date().optional(),
  minImportance: z.coerce.number().min(0).max(1).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  includeSuperseded: queryBool,
  entityId: z.string().uuid().optional(),
  includeChunks: queryBool,
  includePreferences: queryBool,
  includeInsights: queryBool,
  // v1.2: opt-in inclusion of new categories.
  includeKnowledge: queryBool,
  includeProcedures: queryBool,
  includeResearch: queryBool,
  includeIntentions: queryBool,
  // Session working-memory observations (requires sessionId).
  includeObservations: queryBool,
  rerank: queryBool,
  // Opt-in Personalized PageRank retrieval (HippoRAG-style). Requires the GDS
  // projection (built by the dream cycle when RETRIEVAL_ENABLE_PPR=1).
  ppr: queryBool,
  debug: queryBool,
  chunkNeighborRadius: z.coerce.number().int().min(1).max(3).optional(),
});

const ResponseShape = okEnvelope(
  z.object({
    facts: z.array(WireFactWithScoreSchema),
    entities: z.array(WireEntitySchema).optional(),
    chunks: z.array(WireChunkSchema.extend(ScoreFields)).optional(),
    preferences: z.array(WirePreferenceWithScoreSchema).optional(),
    insights: z.array(WireInsightWithScoreSchema).optional(),
    knowledgeChunks: z.array(WireKnowledgeChunkSchema.extend(ScoreFields)).optional(),
    procedures: z.array(WireProcedureSchema.extend(ScoreFields)).optional(),
    research: z.array(WireResearchSchema.extend(ScoreFields)).optional(),
    researchChunks: z.array(WireResearchChunkSchema.extend(ScoreFields)).optional(),
    intentions: z.array(WireIntentionSchema.extend(ScoreFields)).optional(),
    observations: z.array(WireObservationSchema.extend(ScoreFields)).optional(),
    trace: WireRecallTraceSchema.optional(),
  }),
);

export function registerRecallRoute(app: App, container: Container): void {
  app.route({
    method: 'GET',
    url: '/recall',
    schema: {
      querystring: Query,
      response: { 200: ResponseShape },
    },
    handler: async (req) => {
      assertObservationsReachable(req.query);
      const result = await container.retrieval.recall(req.query);
      return {
        ok: true as const,
        data: {
          facts: result.facts.map((f) => ({
            ...toWireFact(f),
            score: f.score,
            vectorScore: f.vectorScore,
            expansionReason: f.expansionReason,
          })),
          entities: result.entities.map(toWireEntity),
          ...(result.chunks && {
            chunks: result.chunks.map((c) => ({
              ...toWireChunk(c),
              score: c.score,
              vectorScore: c.vectorScore,
              expansionReason:
                c.expansionReason === 'chunk_vector' ||
                c.expansionReason === 'chunk_fulltext' ||
                c.expansionReason === 'chunk_neighbor'
                  ? c.expansionReason
                  : undefined,
            })),
          }),
          ...(result.preferences && {
            preferences: result.preferences.map((p) => ({
              ...toWirePreference(p),
              score: p.score,
              vectorScore: p.vectorScore,
            })),
          }),
          ...(result.insights && {
            insights: result.insights.map((i) => ({
              ...toWireInsight(i),
              score: i.score,
              vectorScore: i.vectorScore,
            })),
          }),
          ...(result.knowledgeChunks && {
            knowledgeChunks: result.knowledgeChunks.map((c) => ({
              ...toWireKnowledgeChunk(c),
              score: c.score,
              vectorScore: c.vectorScore,
            })),
          }),
          ...(result.procedures && {
            procedures: result.procedures.map((p) => ({
              ...toWireProcedure(p),
              score: p.score,
              vectorScore: p.vectorScore,
            })),
          }),
          ...(result.research && {
            research: result.research.map((r) => ({
              ...toWireResearch(r),
              score: r.score,
              vectorScore: r.vectorScore,
            })),
          }),
          ...(result.researchChunks && {
            researchChunks: result.researchChunks.map((c) => ({
              ...toWireResearchChunk(c),
              score: c.score,
              vectorScore: c.vectorScore,
            })),
          }),
          ...(result.intentions && {
            intentions: result.intentions.map((i) => ({
              ...toWireIntention(i),
              score: i.score,
              vectorScore: i.vectorScore,
            })),
          }),
          ...(result.observations && {
            observations: result.observations.map((o) => ({
              ...toWireObservation(o),
              score: o.score,
              vectorScore: o.vectorScore,
            })),
          }),
          ...(result.trace && { trace: result.trace }),
        },
      };
    },
  });
}

// Observation recall has two ways to silently return nothing: it is hard-scoped
// to one session at the source, and `kinds` is a hard filter applied to every
// category. Both are easy to hit by accident and indistinguishable from "this
// session has no matching observations", so reject rather than answer empty.
function assertObservationsReachable(q: z.infer<typeof Query>): void {
  if (!q.includeObservations) return;
  if (!q.sessionId) {
    throw badRequest('includeObservations requires sessionId — observations are session-scoped');
  }
  if (q.kinds && q.kinds.length > 0 && !q.kinds.includes('observation')) {
    throw badRequest("includeObservations requires 'observation' in kinds, which is a hard filter");
  }
}
