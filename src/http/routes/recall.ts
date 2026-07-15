import { z } from 'zod';
import type { Container } from '../../index.ts';
import {
  toWireChunk,
  toWireEntity,
  toWireFact,
  toWireInsight,
  toWireIntention,
  toWireKnowledgeChunk,
  toWirePreference,
  toWireProcedure,
  toWireResearch,
} from '../../models/wire.ts';
import type { App } from '../types.ts';
import {
  WireChunkSchema,
  WireEntitySchema,
  WireFactWithScoreSchema,
  WireInsightWithScoreSchema,
  WireIntentionSchema,
  WireKnowledgeChunkSchema,
  WireMemoryKindSchema,
  WirePreferenceWithScoreSchema,
  WireProcedureSchema,
  WireRecallTraceSchema,
  WireResearchSchema,
  okEnvelope,
  queryBool,
} from '../wire-schemas.ts';

const Scope = z.enum(['boost', 'filter', 'none', 'strict']);

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
  agentScope: Scope.optional(),
  sessionScope: Scope.optional(),
  // v1.2: cross-cutting scope axes.
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  projectScope: Scope.optional(),
  userScope: Scope.optional(),
  // v1.2: restrict search to specific memory kinds (comma-separated).
  kinds: Kinds.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
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
    chunks: z.array(WireChunkSchema).optional(),
    preferences: z.array(WirePreferenceWithScoreSchema).optional(),
    insights: z.array(WireInsightWithScoreSchema).optional(),
    knowledgeChunks: z.array(WireKnowledgeChunkSchema.extend({ score: z.number() })).optional(),
    procedures: z.array(WireProcedureSchema.extend({ score: z.number() })).optional(),
    research: z.array(WireResearchSchema.extend({ score: z.number() })).optional(),
    intentions: z.array(WireIntentionSchema.extend({ score: z.number() })).optional(),
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
      const result = await container.retrieval.recall(req.query);
      return {
        ok: true as const,
        data: {
          facts: result.facts.map((f) => ({
            ...toWireFact(f),
            score: f.score,
            expansionReason: f.expansionReason,
          })),
          entities: result.entities.map(toWireEntity),
          ...(result.chunks && {
            chunks: result.chunks.map((c) => ({
              ...toWireChunk(c),
              score: c.score,
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
            })),
          }),
          ...(result.insights && {
            insights: result.insights.map((i) => ({
              ...toWireInsight(i),
              score: i.score,
            })),
          }),
          ...(result.knowledgeChunks && {
            knowledgeChunks: result.knowledgeChunks.map((c) => ({
              ...toWireKnowledgeChunk(c),
              score: c.score,
            })),
          }),
          ...(result.procedures && {
            procedures: result.procedures.map((p) => ({
              ...toWireProcedure(p),
              score: p.score,
            })),
          }),
          ...(result.research && {
            research: result.research.map((r) => ({
              ...toWireResearch(r),
              score: r.score,
            })),
          }),
          ...(result.intentions && {
            intentions: result.intentions.map((i) => ({
              ...toWireIntention(i),
              score: i.score,
            })),
          }),
          ...(result.trace && { trace: result.trace }),
        },
      };
    },
  });
}
