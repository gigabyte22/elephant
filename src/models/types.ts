import { z } from 'zod';

// Embeddings travel through the system as plain number arrays.
// Length is enforced at the adapter / migrate boundary, not in the schema.
export const EmbeddingSchema = z.array(z.number());
export type Embedding = z.infer<typeof EmbeddingSchema>;

// --- Memory category discriminator ----------------------------------------
// `kind` is a label-agnostic property mirrored on every memory node, written
// alongside the `:MemoryItem` base label so callers can filter without
// caring about the secondary label set. See SPEC.md "Hybrid label model".

export const MemoryKindSchema = z.enum([
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
  'intention',
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

// --- Scope -----------------------------------------------------------------
// Optional cross-cutting scope axes layered on top of the existing
// agentId / sessionId model. `projectId` isolates research/project work;
// `userId` identifies the human behind a request when the orchestrator
// chooses to forward it.

export const ScopeSchema = z.object({
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
});
export type Scope = z.infer<typeof ScopeSchema>;

// --- Episode ---------------------------------------------------------------

// Where an episode came from. 'user' = a real human conversation; 'cron' /
// 'event' / 'system' = autonomous runs with no human present (trigger text is
// machine-generated); 'ingest' = content ingestion (documents, transcripts of
// media), not a conversation with the user at all. The dreamer feeds this to
// fact extraction so autonomous activity is never attributed to "the user".
export const EpisodeOriginSchema = z.enum(['user', 'cron', 'event', 'system', 'ingest']);
export type EpisodeOrigin = z.infer<typeof EpisodeOriginSchema>;

export const EpisodeSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
    timestamp: z.date(),
    rawTranscript: z.string(),
    summary: z.string(),
    embedding: EmbeddingSchema,
    origin: EpisodeOriginSchema.optional(),
    // Isolated projects opt out of cross-scope dedup/supersede against the
    // personal bucket, keeping their facts fully self-contained.
    isolated: z.boolean().optional(),
  })
  .merge(ScopeSchema);
export type Episode = z.infer<typeof EpisodeSchema>;

// --- Chunk (sub-piece of an Episode's rawTranscript) ----------------------
// Chunks exist so long transcripts remain searchable past the embedder's
// per-input token limit. Every Episode has at least one Chunk; short
// transcripts yield exactly one. Facts extracted during dreaming trace back
// to the specific Chunk that grounded them via :DERIVED_FROM.

export const ChunkSchema = z
  .object({
    id: z.string().uuid(),
    episodeId: z.string().uuid(),
    position: z.number().int().nonnegative(),
    text: z.string().min(1),
    tokenCount: z.number().int().nonnegative(),
    embedding: EmbeddingSchema,
    createdAt: z.date(),
  })
  .merge(ScopeSchema);
export type Chunk = z.infer<typeof ChunkSchema>;

// --- Entity ---------------------------------------------------------------

export const EntityTypeSchema = z.string().min(1); // free-form (Person, Concept, Tool, …)

export const EntitySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: EntityTypeSchema,
  embedding: EmbeddingSchema,
});
export type Entity = z.infer<typeof EntitySchema>;

// --- Fact ------------------------------------------------------------------

export const FactSchema = z
  .object({
    id: z.string().uuid(),
    content: z.string().min(1),
    category: z.string().optional(),
    confidence: z.number().min(0).max(1),
    importance: z.number().min(0).max(1),
    validFrom: z.date(),
    validTo: z.date().nullable(),
    recordedAt: z.date(),
    embedding: EmbeddingSchema,
    entityIds: z.array(z.string().uuid()).default([]),
    supersedesFactId: z.string().uuid().optional(),
    // Set on facts produced by the dreamer's consolidation pass: the member
    // facts this one merged. Lineage is also on (:Fact)-[:SUPERSEDES]-> edges;
    // supersedesFactId stays unset for merges (a scalar can't hold N ids).
    mergedFromFactIds: z.array(z.string().uuid()).optional(),
    sourceEpisodeId: z.string().uuid().optional(),
    // Access telemetry — written by retrieval's refcount tick, read by the
    // dreaming importance formula and by retrieval scoring. Nullable/0 default
    // keeps it backwards-compatible with facts written before the columns existed.
    referenceCount: z.number().int().nonnegative().optional(),
    lastReferencedAt: z.date().nullable().optional(),
    // Optional origin scope for direct writes with no source episode
    // (precedent: IntentionSchema). Facts extracted from episodes derive
    // origin from the episode instead; these stay unset there.
    agentId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .merge(ScopeSchema);
export type Fact = z.infer<typeof FactSchema>;

// --- Intention (prospective memory) ----------------------------------------
// A durable, recallable record of a forward-looking commitment: "notify the user
// before their car registration expires". Elephant is pull-only and does NOT
// fire intentions — an external orchestrator or scheduler owns the
// clock. This node is the audited *memory* of the intention and its lifecycle;
// `listDue` exists for boot-time reconciliation / "list my open commitments",
// not for continuous polling. Bi-temporal fields mirror Fact: `validTo` is set
// when the intention reaches a terminal status (completed/cancelled/expired).
// Either `dueAt` (time-due-able) or `triggerHint` (free-text condition, e.g.
// "when the user next mentions billing") must be present — enforced at the
// service layer.

export const IntentionStatusSchema = z.enum(['pending', 'completed', 'cancelled', 'expired']);
export type IntentionStatus = z.infer<typeof IntentionStatusSchema>;

export const IntentionSchema = z
  .object({
    id: z.string().uuid(),
    content: z.string().min(1),
    status: IntentionStatusSchema.default('pending'),
    dueAt: z.date().nullable(),
    triggerHint: z.string().min(1).nullable(),
    // Recurrence. `schedule` holds the cron / recurrence expression (null for
    // one-shot or trigger-only intentions); `recurring` is true when it fires
    // more than once. `fireCount`/`lastFiredAt` track recurring fires durably
    // so "how often did we act on this?" is queryable without re-parsing the
    // schedule, and recurring fires leave a permanent trail (each fire emits an
    // audit event) rather than an expiring observation.
    recurring: z.boolean().default(false),
    schedule: z.string().min(1).nullable(),
    fireCount: z.number().int().nonnegative().default(0),
    lastFiredAt: z.date().nullable(),
    // bi-temporal, mirrors Fact.validFrom/validTo
    validFrom: z.date(),
    validTo: z.date().nullable(),
    createdAt: z.date(),
    completedAt: z.date().nullable(),
    embedding: EmbeddingSchema,
    importance: z.number().min(0).max(1).default(0.5),
    // Optional agent/session scope (precedent: ObservationSchema) so the poll
    // can be agent-scoped. projectId/userId come from ScopeSchema below.
    agentId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    // provenance — which episode/fact this intention arose from
    sourceEpisodeId: z.string().uuid().optional(),
    sourceFactId: z.string().uuid().optional(),
  })
  .merge(ScopeSchema);
export type Intention = z.infer<typeof IntentionSchema>;

// --- Preference ------------------------------------------------------------

export const PreferenceSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string().min(1),
    value: z.string(),
    confidence: z.number().min(0).max(1),
    validFrom: z.date(),
    validTo: z.date().nullable(),
    embedding: EmbeddingSchema,
  })
  .merge(ScopeSchema);
export type Preference = z.infer<typeof PreferenceSchema>;

// --- Insight ---------------------------------------------------------------

export const InsightSchema = z
  .object({
    id: z.string().uuid(),
    content: z.string().min(1),
    embedding: EmbeddingSchema,
    promotedFromFactIds: z.array(z.string().uuid()).default([]),
    createdAt: z.date(),
  })
  .merge(ScopeSchema);
export type Insight = z.infer<typeof InsightSchema>;

// --- Observation (working memory, TTL) -------------------------------------

export const ObservationSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
    content: z.string().min(1),
    recordedAt: z.date(),
    expiresAt: z.date(),
    embedding: EmbeddingSchema,
  })
  .merge(ScopeSchema);
export type Observation = z.infer<typeof ObservationSchema>;

// --- KnowledgeDocument -----------------------------------------------------
// Top-level shared/RAG document. Carries a summary embedding for document-
// level retrieval; full content is split into KnowledgeChunks.

export const KnowledgeDocumentSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1),
    source: z.string().min(1), // e.g. 'book:XYZ.pdf', 'url', 'manual'
    sourceUri: z.string().optional(),
    content: z.string().optional(), // raw note/document body, retained for editing
    contentHash: z.string().optional(), // sha256 of raw content for dedup
    summary: z.string(),
    embedding: EmbeddingSchema, // embedding of the summary
    tags: z.array(z.string()).default([]),
    expiresAt: z.date().nullable().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .merge(ScopeSchema);
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;

// --- KnowledgeChunk --------------------------------------------------------
// Same shape as Chunk but rooted at a KnowledgeDocument instead of an Episode.
// `attachmentId` is set for chunks derived from an attachment's extracted text
// so they can be removed when that attachment is deleted.

export const KnowledgeChunkSchema = z
  .object({
    id: z.string().uuid(),
    documentId: z.string().uuid(),
    attachmentId: z.string().uuid().optional(),
    position: z.number().int().nonnegative(),
    text: z.string().min(1),
    tokenCount: z.number().int().nonnegative(),
    embedding: EmbeddingSchema,
    createdAt: z.date(),
  })
  .merge(ScopeSchema);
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

// --- KnowledgeAttachment ---------------------------------------------------
// A binary file attached to a KnowledgeDocument. Bytes live in the blob store
// (referenced by blobId); extracted text is indexed as KnowledgeChunks.

export const ExtractionStatusSchema = z.enum(['done', 'empty', 'unsupported', 'skipped', 'failed']);
export type ExtractionStatusValue = z.infer<typeof ExtractionStatusSchema>;

export const KnowledgeAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    documentId: z.string().uuid(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string(),
    blobId: z.string(),
    extractionStatus: ExtractionStatusSchema,
    extractedChars: z.number().int().nonnegative().default(0),
    detail: z.string().optional(),
    createdAt: z.date(),
  })
  .merge(ScopeSchema);
export type KnowledgeAttachment = z.infer<typeof KnowledgeAttachmentSchema>;

// --- Procedure -------------------------------------------------------------
// Workflows / skills / agent how-to. Versioned; updates archive previous
// revisions and emit :SUPERSEDES edges to the prior version.

export const ProcedureSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    version: z.number().int().positive().default(1),
    content: z.string().min(1), // body — instructions, steps, prompt template
    whenToUse: z.string().min(1), // trigger / selection hint
    embedding: EmbeddingSchema, // embedding of (whenToUse + '\n' + content)
    successRate: z.number().min(0).max(1).default(0.5),
    invocationCount: z.number().int().nonnegative().default(0),
    lastSuccessAt: z.date().nullable().optional(),
    expiresAt: z.date().nullable().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .merge(ScopeSchema);
export type Procedure = z.infer<typeof ProcedureSchema>;

// --- Research --------------------------------------------------------------
// Project-scoped findings/artifacts. Same node shape as KnowledgeDocument
// but `projectId` is required so retrieval and isolation are unambiguous.

export const ResearchSchema = KnowledgeDocumentSchema.extend({
  projectId: z.string().min(1),
});
export type Research = z.infer<typeof ResearchSchema>;

// --- ArchivedRevision ------------------------------------------------------
// Snapshot of a memory item taken before mutation. Linked to the live node
// via (:MemoryItem)-[:HAS_REVISION]->(:ArchivedRevision).

export const ArchivedRevisionSchema = z.object({
  id: z.string().uuid(),
  originalId: z.string().uuid(),
  originalKind: MemoryKindSchema,
  snapshot: z.string(), // JSON-serialised pre-update node state
  archivedAt: z.date(),
  reason: z.string(),
  archivedBy: z.string().optional(), // actor id (agent/user) when known
});
export type ArchivedRevision = z.infer<typeof ArchivedRevisionSchema>;

// --- AuditEvent ------------------------------------------------------------
// Append-only event log. Every mutating service emits one of these so we
// can reconstruct who-did-what across the entire memory graph.

export const AuditEventKindSchema = z.enum([
  'create',
  'update',
  'supersede',
  'soft_delete',
  'prune',
  'promote',
  'archive',
  'merge',
]);
export type AuditEventKind = z.infer<typeof AuditEventKindSchema>;

export const AuditEventSchema = z.object({
  id: z.string().uuid(),
  kind: AuditEventKindSchema,
  targetId: z.string().uuid(),
  targetKind: MemoryKindSchema,
  payload: z.string(), // JSON-serialised event-specific details
  at: z.date(),
  actor: z.string().optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// --- WorkingState ----------------------------------------------------------
// Pluggable key/value live orchestration state. Persisted via the
// WorkingStateAdapter (Neo4j default, Redis optional). NOT a memory item;
// no :MemoryItem label, no embedding, no retrieval pipeline involvement.

export const WorkingStateScopeSchema = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});
export type WorkingStateScope = z.infer<typeof WorkingStateScopeSchema>;

export const WorkingStateEntrySchema = z.object({
  scope: WorkingStateScopeSchema,
  key: z.string().min(1),
  value: z.unknown(),
  expiresAt: z.date().nullable(),
  updatedAt: z.date(),
});
export type WorkingStateEntry = z.infer<typeof WorkingStateEntrySchema>;

// --- DreamRun (audit) ------------------------------------------------------

export const DreamRunStatusSchema = z.enum(['running', 'completed', 'failed']);
export type DreamRunStatus = z.infer<typeof DreamRunStatusSchema>;

export const DreamRunSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.date(),
  completedAt: z.date().nullable(),
  status: DreamRunStatusSchema,
  episodesProcessed: z.number().int().nonnegative().default(0),
  episodesFailed: z.number().int().nonnegative().default(0),
  factsCreated: z.number().int().nonnegative().default(0),
  factsSuperseded: z.number().int().nonnegative().default(0),
  factsPruned: z.number().int().nonnegative().default(0),
  factsMerged: z.number().int().nonnegative().default(0),
  insightsPromoted: z.number().int().nonnegative().default(0),
  extractionFailures: z.number().int().nonnegative().default(0),
  supersedeFailures: z.number().int().nonnegative().default(0),
  // Knowledge-graph construction (v1.3): relation/triple edges built, entity
  // synonym edges added, and entities re-embedded from their name this cycle.
  relationsCreated: z.number().int().nonnegative().default(0),
  synonymsCreated: z.number().int().nonnegative().default(0),
  entitiesReembedded: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
});
export type DreamRun = z.infer<typeof DreamRunSchema>;

// --- Supersede payload (used by ingestion + dreaming) ----------------------

export const SupersedeDecisionSchema = z.object({
  oldFactId: z.string().uuid(),
  newFactId: z.string().uuid(),
  reason: z.string(),
  confidenceDelta: z.number(),
});
export type SupersedeDecision = z.infer<typeof SupersedeDecisionSchema>;

// --- Extracted fact (LLM output, pre-embedding) ----------------------------

// A named entity the extractor attached to a fact, with its classified type
// (person, project, tool, concept, …). Type lets the entity graph carry real
// signal instead of everything collapsing to "Concept".
export const ExtractedEntitySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1).default('Concept'),
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

export const ExtractedFactSchema = z.object({
  content: z.string().min(1),
  category: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.7),
  importance: z.number().min(0).max(1).default(0.5),
  // Preferred: typed entities. `entityNames` is kept for back-compat with models
  // (and test fixtures) that still emit a flat name list; consumers should merge
  // both via `resolveExtractedEntities`. Optional rather than defaulted so plain
  // object literals satisfy the type without restating it.
  entities: z.array(ExtractedEntitySchema).optional(),
  entityNames: z.array(z.string().min(1)).default([]),
});
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

// --- Extracted relation (LLM OpenIE output, dream cycle) -------------------
// A directed (subject, predicate, object) triple between two named entities,
// extracted during dreaming. Subject/object are entity NAMES (resolved to ids
// by the caller against the entities already upserted for the episode). Stored
// as (:Entity)-[:RELATES {predicate, confidence}]->(:Entity); PageRank traverses
// these (plus :SYNONYM and :HAS_FACT) for multi-hop recall.
export const ExtractedRelationSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.7),
});
export type ExtractedRelation = z.infer<typeof ExtractedRelationSchema>;

// Normalize an extracted fact's entities into a single typed list, folding in
// any legacy bare `entityNames` (typed as 'Concept') that weren't already named
// in `entities`.
export function resolveExtractedEntities(fact: ExtractedFact): ExtractedEntity[] {
  const out: ExtractedEntity[] = [...(fact.entities ?? [])];
  const seen = new Set(out.map((e) => e.name.trim().toLowerCase()));
  for (const name of fact.entityNames) {
    const norm = name.trim().toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push({ name, type: 'Concept' });
    }
  }
  return out;
}

// --- ScopeMode -------------------------------------------------------------
// How a scope axis is applied at retrieval time. Mirrors the existing
// agentScope / sessionScope semantics.
//
// - 'boost'  : include everything, rank in-scope items higher.
// - 'filter' : exclude items scoped to a *different* value, but KEEP unscoped
//              (null) items — they're treated as globally shared.
// - 'strict' : like 'filter' but ALSO exclude unscoped (null) items, so a
//              sandboxed (isolated) reader sees only its own scope.
// - 'none'   : ignore this axis entirely.

export const ScopeModeSchema = z.enum(['boost', 'filter', 'none', 'strict']);
export type ScopeMode = z.infer<typeof ScopeModeSchema>;
