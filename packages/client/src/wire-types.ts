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

export type WireFactWithScore = WireFact & { score: number; expansionReason?: string };

export interface WirePreference extends WireScope {
  key: string;
  value: string;
  confidence: number;
  validFrom: string;
  validTo: string | null;
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
  kind: 'create' | 'update' | 'supersede' | 'soft_delete' | 'prune' | 'promote' | 'archive';
  targetId: string;
  targetKind: string;
  payload: unknown;
  at: string;
  actor?: string;
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
  };
}

// ── Recall ──────────────────────────────────────────────────────────────────

export type ScopeMode = 'boost' | 'filter' | 'none' | 'strict';

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
  | 'research';

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
  rerank?: boolean;
  debug?: boolean;
  chunkNeighborRadius?: 1 | 2 | 3;
}

export interface RecallResult {
  facts: WireFactWithScore[];
  entities?: Array<{ id: string; name: string; type: string }>;
  chunks?: Array<{
    id: string;
    episodeId: string;
    position: number;
    text: string;
    createdAt: string;
    score: number;
  }>;
  preferences?: Array<WirePreference & { score: number }>;
  insights?: Array<WireInsight & { score: number }>;
  knowledgeChunks?: Array<{
    id: string;
    documentId: string;
    title?: string;
    position: number;
    text: string;
    createdAt: string;
    score: number;
  }>;
  procedures?: Array<WireProcedure & { score: number }>;
  research?: Array<WireResearch & { score: number }>;
  trace?: {
    stageTimingsMs: Record<string, number>;
    rerankUsed: boolean;
    candidatesSeen: Record<string, number>;
  };
}
