// GENERATED — do not edit. Source: packages/client/src.
// Regenerate with: pnpm sync:vendored-client
// Wire types mirroring elephant's src/models/wire.ts (HTTP boundary shapes).
// Deliberately duplicated rather than imported from the service source — the
// repo convention is that consumers pin compatibility via GET /health rather
// than share code (see EXPECTED.md §3). Dates are ISO strings on the wire.

export interface WireScope {
  projectId?: string;
  userId?: string;
}

export interface WireFact extends WireScope {
  id: string;
  content: string;
  category?: string;
  confidence: number;
  importance: number;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  entities: string[];
  supersedes?: string;
  sourceEpisodeId?: string;
  // Origin scope stamped on direct writes (POST /facts with agentId/sessionId).
  agentId?: string;
  sessionId?: string;
  refCount?: number;
  originAgentId?: string | null;
  originSessionId?: string | null;
}

/**
 * The two numbers a recall item carries.
 *
 * `score` orders one result set. `vectorScore` is the raw similarity behind it,
 * before fusion and blending, and is the only one comparable ACROSS queries —
 * threshold on it to abstain rather than show the least-bad match. Absent when
 * an item arrived by a route with no vector score behind it (a full-text hit,
 * an entity sibling, a chunk neighbour).
 *
 * INTEGRATION.md § "Ranking vs. thresholding" has the long version.
 */
export type WithScore<T> = T & { score: number; vectorScore?: number };

export type WireFactWithScore = WithScore<WireFact> & { expansionReason?: string };

export interface WirePreference extends WireScope {
  key: string;
  value: string;
  confidence: number;
  validFrom: string;
  validTo: string | null;
  /** Transaction time; optional for pre-bitemporal rows / older servers. */
  recordedAt?: string;
}

export interface WireObservation extends WireScope {
  id: string;
  agentId: string;
  sessionId: string;
  content: string;
  recordedAt: string;
  expiresAt: string;
}

export interface WireInsight extends WireScope {
  id: string;
  content: string;
  promotedFromFactIds: string[];
  createdAt: string;
}

export interface WireIntention extends WireScope {
  id: string;
  content: string;
  status: 'pending' | 'completed' | 'cancelled' | 'expired';
  dueAt: string | null;
  triggerHint: string | null;
  recurring: boolean;
  schedule: string | null;
  fireCount: number;
  lastFiredAt: string | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  completedAt: string | null;
  importance: number;
  agentId?: string;
  sessionId?: string;
  sourceEpisodeId?: string;
  sourceFactId?: string;
}

export interface WireProcedure extends WireScope {
  id: string;
  name: string;
  version: number;
  content: string;
  whenToUse: string;
  successRate: number;
  invocationCount: number;
  lastSuccessAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WireKnowledgeDocument extends WireScope {
  id: string;
  title: string;
  source: string;
  sourceUri?: string;
  content?: string;
  contentHash?: string;
  summary: string;
  tags: string[];
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  attachments?: WireKnowledgeAttachment[];
}

export interface WireKnowledgeAttachment {
  id: string;
  documentId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  blobId: string;
  extractionStatus: string;
  extractedChars: number;
  detail?: string;
  /** Full extracted text (chunks reassembled in order); present only on single-document GET. */
  extractedText?: string;
  createdAt: string;
  projectId?: string;
  userId?: string;
}

export interface WireResearch extends WireKnowledgeDocument {
  projectId: string;
  /** Caller provenance supplied at create; absent when none was supplied. */
  metadata?: Record<string, string>;
}

export interface WireWorkingStateEntry {
  scope: { agentId: string; sessionId?: string; userId?: string; projectId?: string };
  key: string;
  value: unknown;
  expiresAt: string | null;
  updatedAt: string;
}

export interface WireAuditEvent {
  id: string;
  kind:
    | 'create'
    | 'update'
    | 'supersede'
    | 'soft_delete'
    | 'prune'
    | 'promote'
    | 'archive'
    | 'merge';
  /** Not guaranteed to be a UUID — the append-only log may carry legacy id strings. */
  targetId: string;
  targetKind: RecallKind;
  payload: unknown;
  at: string;
  actor?: string;
}

export interface WireArchivedRevision {
  id: string;
  originalId: string;
  originalKind: RecallKind;
  /** Parsed JSON when the stored snapshot is valid JSON, else the raw string. */
  snapshot: unknown;
  archivedAt: string;
  reason: string;
  archivedBy?: string;
}

export interface WireHealth {
  neo4j: boolean;
  llm: { name: string; maxContextTokens: number };
  embedder: { name: string; dim: number; maxInputTokens: number };
  schemaVectorDim?: number | null;
  dream: {
    lastRun: string | null;
    lastRunDurationMs: number | null;
    running: boolean;
    runningJobId: string | null;
    backlogEstimate: number | null;
    // Episodes that exhausted their dream attempts. Optional: older servers
    // do not report it.
    deadLetteredEpisodes?: number | null;
  };
  // Attachment text extraction queue. Optional: older servers do not report it.
  extraction?: {
    pending: number | null;
    /** Spent their retries; recoverable only via the backfill script. */
    deadLettered: number | null;
  };
  /**
   * Capability flag: POST /episodes accepts the optional `metadata` map.
   * Absent on servers that predate it — feature-detect before sending.
   */
  episodeMetadata?: true;
  /** Capability flag: POST /research accepts the optional `metadata` map. */
  researchMetadata?: true;
  /** Capability flag: GET /research/:id/similar exists. */
  researchSimilar?: true;
}

// ── Recall ──────────────────────────────────────────────────────────────────

export type ScopeMode = 'boost' | 'filter' | 'none' | 'shared' | 'strict';

export type RecallKind =
  | 'episode'
  | 'chunk'
  | 'fact'
  | 'preference'
  | 'insight'
  | 'observation'
  | 'knowledge_document'
  | 'knowledge_chunk'
  | 'procedure'
  | 'research'
  | 'research_chunk'
  | 'intention';

export interface RecallQuery {
  q: string;
  agentId?: string;
  sessionId?: string;
  projectId?: string;
  userId?: string;
  agentScope?: ScopeMode;
  sessionScope?: ScopeMode;
  projectScope?: ScopeMode;
  userScope?: ScopeMode;
  kinds?: RecallKind[];
  from?: Date;
  to?: Date;
  /** Valid-time as-of for facts (default: now when not includeSuperseded). */
  asOf?: Date;
  minImportance?: number;
  minConfidence?: number;
  limit?: number;
  includeSuperseded?: boolean;
  entityId?: string;
  includeChunks?: boolean;
  includePreferences?: boolean;
  includeInsights?: boolean;
  includeKnowledge?: boolean;
  includeProcedures?: boolean;
  includeResearch?: boolean;
  includeIntentions?: boolean;
  /** Session working memory; requires sessionId. */
  includeObservations?: boolean;
  rerank?: boolean;
  /** Personalized PageRank. No-ops server-side unless the GDS projection exists. */
  ppr?: boolean;
  debug?: boolean;
  chunkNeighborRadius?: 1 | 2 | 3;
}

/** Fields common to every chunk kind. Each kind adds its own parent id
 *  (`episodeId` / `documentId` / `researchId`); only the knowledge and research
 *  chunks carry scope. */
export interface WireChunkBase {
  id: string;
  position: number;
  text: string;
  createdAt: string;
}

export interface RecallResult {
  facts: WireFactWithScore[];
  entities?: Array<{ id: string; name: string; type: string }>;
  chunks?: Array<WithScore<WireChunkBase & { episodeId: string }>>;
  preferences?: Array<WithScore<WirePreference>>;
  insights?: Array<WithScore<WireInsight>>;
  knowledgeChunks?: Array<
    WithScore<
      WireScope &
        WireChunkBase & {
          documentId: string;
          /** 'model' when a model produced this text from non-text bytes (OCR, a
           *  transcription, an image description) rather than it being the
           *  source's own words. Quote it accordingly. */
          derivation: 'verbatim' | 'model';
        }
    >
  >;
  procedures?: Array<WithScore<WireProcedure>>;
  research?: Array<WithScore<WireResearch>>;
  researchChunks?: Array<WithScore<WireScope & WireChunkBase & { researchId: string }>>;
  intentions?: Array<WithScore<WireIntention>>;
  observations?: Array<WithScore<WireObservation>>;
  trace?: {
    stageTimingsMs: Record<string, number>;
    rerankUsed: boolean;
    candidatesSeen: Record<string, number>;
  };
}
