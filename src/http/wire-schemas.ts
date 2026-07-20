// Single source of truth for the Zod shapes that mirror src/models/wire.ts.
// Every route schema lives here so the wire contract (EXPECTED.md §3) drifts
// in exactly one place.

import { z } from 'zod';

// Boolean query-string parser for routes. z.coerce.boolean() uses JS Boolean()
// semantics, so `?flag=false` (and `=0`, `=no`) coerces to TRUE — silently
// inverting opt-out params. This parses the usual truthy spellings as true and
// everything else as false; stays `.optional()` so an absent param is undefined.
export const queryBool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) =>
    v === undefined
      ? undefined
      : typeof v === 'boolean'
        ? v
        : ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()),
  );

// Scope fields shared across every memory item's wire representation.
const ScopeFields = {
  projectId: z.string().optional(),
  userId: z.string().optional(),
};

export const WireFactSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  category: z.string().optional(),
  confidence: z.number(),
  importance: z.number(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  recordedAt: z.string(),
  entities: z.array(z.string()),
  supersedes: z.string().optional(),
  sourceEpisodeId: z.string().optional(),
  // Origin scope stamped on direct writes (POST /facts with agentId/sessionId).
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  // Optional retrieval metadata (populated by /recall; absent in /facts POST response).
  refCount: z.number().int().nonnegative().optional(),
  originAgentId: z.string().nullable().optional(),
  originSessionId: z.string().nullable().optional(),
  ...ScopeFields,
});

export const WireFactWithScoreSchema = WireFactSchema.extend({
  score: z.number(),
  expansionReason: z
    .enum([
      'fact_vector',
      'fact_fulltext',
      'chunk_vector',
      'chunk_fulltext',
      'preference_vector',
      'insight_vector',
      'knowledge_chunk_vector',
      'knowledge_chunk_fulltext',
      'procedure_vector',
      'procedure_fulltext',
      'research_vector',
      'research_chunk_vector',
      'research_chunk_fulltext',
      'intention_vector',
      'entity_sibling',
      'entity_ppr',
      'chunk_derived',
      'chunk_neighbor',
      'rerank',
    ])
    .optional(),
});

export const WireChunkSchema = z.object({
  id: z.string().uuid(),
  episodeId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  text: z.string(),
  createdAt: z.string(),
  score: z.number().optional(),
  expansionReason: z.enum(['chunk_vector', 'chunk_fulltext', 'chunk_neighbor']).optional(),
});

export const WirePreferenceWithScoreSchema = z.object({
  key: z.string(),
  value: z.string(),
  confidence: z.number(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  score: z.number(),
});

export const WireInsightWithScoreSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  promotedFromFactIds: z.array(z.string()),
  createdAt: z.string(),
  score: z.number(),
});

export const WireRecallTraceSchema = z.object({
  stageTimingsMs: z.record(z.string(), z.number()),
  rerankUsed: z.boolean(),
  candidatesSeen: z.object({
    facts: z.number().int().nonnegative(),
    chunks: z.number().int().nonnegative(),
    preferences: z.number().int().nonnegative(),
    insights: z.number().int().nonnegative(),
    knowledgeChunks: z.number().int().nonnegative(),
    procedures: z.number().int().nonnegative(),
    research: z.number().int().nonnegative(),
    researchChunks: z.number().int().nonnegative(),
  }),
});

export const WireEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

export const WirePreferenceSchema = z.object({
  key: z.string(),
  value: z.string(),
  confidence: z.number(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});

export const WireObservationSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string(),
  sessionId: z.string(),
  content: z.string(),
  recordedAt: z.string(),
  expiresAt: z.string(),
});

export const WireDreamRunSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  status: z.enum(['running', 'completed', 'failed']),
  episodesProcessed: z.number(),
  factsCreated: z.number(),
  factsSuperseded: z.number(),
  factsPruned: z.number(),
  factsMerged: z.number().default(0),
  insightsPromoted: z.number(),
  error: z.string().optional(),
});

// --- v1.2 wire shapes ----------------------------------------------------

export const WireKnowledgeAttachmentSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  blobId: z.string(),
  extractionStatus: z.string(),
  extractedChars: z.number().int().nonnegative(),
  detail: z.string().optional(),
  extractedText: z.string().optional(),
  createdAt: z.string(),
  ...ScopeFields,
});

export const WireKnowledgeDocumentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  source: z.string(),
  sourceUri: z.string().optional(),
  content: z.string().optional(),
  contentHash: z.string().optional(),
  summary: z.string(),
  tags: z.array(z.string()),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  attachments: z.array(WireKnowledgeAttachmentSchema).optional(),
  ...ScopeFields,
});

export const WireKnowledgeChunkSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  text: z.string(),
  createdAt: z.string(),
  ...ScopeFields,
});

export const WireProcedureSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  version: z.number().int().positive(),
  content: z.string(),
  whenToUse: z.string(),
  successRate: z.number(),
  invocationCount: z.number().int().nonnegative(),
  lastSuccessAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  ...ScopeFields,
});

export const WireResearchSchema = WireKnowledgeDocumentSchema.extend({
  projectId: z.string(),
});

export const WireResearchChunkSchema = z.object({
  id: z.string().uuid(),
  researchId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  text: z.string(),
  createdAt: z.string(),
  ...ScopeFields,
});

export const WireIntentionSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  status: z.enum(['pending', 'completed', 'cancelled', 'expired']),
  dueAt: z.string().nullable(),
  triggerHint: z.string().nullable(),
  recurring: z.boolean(),
  schedule: z.string().nullable(),
  fireCount: z.number().int().nonnegative(),
  lastFiredAt: z.string().nullable(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  importance: z.number(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  sourceEpisodeId: z.string().optional(),
  sourceFactId: z.string().optional(),
  ...ScopeFields,
});

export const WireMemoryKindSchema = z.enum([
  'episode',
  'chunk',
  'fact',
  'preference',
  'insight',
  'observation',
  'knowledge_document',
  'knowledge_chunk',
  'procedure',
  'research',
  'research_chunk',
  'intention',
]);

export const WireArchivedRevisionSchema = z.object({
  id: z.string().uuid(),
  originalId: z.string().uuid(),
  originalKind: WireMemoryKindSchema,
  snapshot: z.unknown(),
  archivedAt: z.string(),
  reason: z.string(),
  archivedBy: z.string().optional(),
});

export const WireAuditEventSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    'create',
    'update',
    'supersede',
    'soft_delete',
    'prune',
    'promote',
    'archive',
    'merge',
  ]),
  // Append-only log — past bugs may have written non-UUID strings; don't 500 the dashboard on them.
  targetId: z.string(),
  targetKind: WireMemoryKindSchema,
  payload: z.unknown(),
  at: z.string(),
  actor: z.string().optional(),
});

export const WireWorkingStateScopeSchema = z.object({
  agentId: z.string(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  projectId: z.string().optional(),
});

export const WireWorkingStateEntrySchema = z.object({
  scope: WireWorkingStateScopeSchema,
  key: z.string(),
  value: z.unknown(),
  expiresAt: z.string().nullable(),
  updatedAt: z.string(),
});

// Wraps a payload schema in the standard { ok: true, data } envelope from
// EXPECTED.md §1. Error envelopes are emitted by errorHandler, not via routes.
export function okEnvelope<S extends z.ZodTypeAny>(data: S) {
  return z.object({ ok: z.literal(true), data });
}
