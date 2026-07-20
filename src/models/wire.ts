// Wire types per EXPECTED.md §3.
// These cross the HTTP boundary; embeddings are stripped, dates serialise as ISO strings.
//
// Internal services pass internal `types.ts` shapes around. Routes call `toWire*`
// before responding. This keeps Neo4j node structure and embedding vectors out of the API.

import type {
  ArchivedRevision,
  AuditEvent,
  AuditEventKind,
  Chunk,
  Entity,
  Fact,
  Insight,
  Intention,
  IntentionStatus,
  KnowledgeAttachment,
  KnowledgeChunk,
  KnowledgeDocument,
  MemoryKind,
  Observation,
  Preference,
  Procedure,
  Research,
  ResearchChunk,
  WorkingStateEntry,
} from './types.ts';

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
  entities: string[]; // entity ids
  supersedes?: string;
  sourceEpisodeId?: string;
  // Origin scope stamped on direct writes (POST /facts with agentId/sessionId).
  agentId?: string;
  sessionId?: string;
  // Retrieval-only metadata, absent on direct fact writes.
  refCount?: number;
  originAgentId?: string | null;
  originSessionId?: string | null;
}

export interface WireChunk extends WireScope {
  id: string;
  episodeId: string;
  position: number;
  text: string;
  createdAt: string;
}

export interface WireRecallResult {
  facts: Array<WireFact & { score: number }>;
  entities?: Array<{ id: string; name: string; type: string }>;
}

export interface WirePreference extends WireScope {
  key: string;
  value: string;
  confidence: number;
  validFrom: string;
  validTo: string | null;
}

export interface WireEpisode extends WireScope {
  id: string;
  agentId: string;
  sessionId: string;
  timestamp: string;
  rawTranscript: string;
  summary: string;
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

export interface WireKnowledgeAttachment extends WireScope {
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
  /**
   * Full text extracted from the attachment, reassembled from its
   * knowledge_chunks in position order. Present only on single-document reads
   * (getWithAttachments); omitted from list/ingest responses, which don't load
   * chunks. This is the authoritative content for PDF/file notes whose typed
   * body is just a stub — knowledge_get surfaces it.
   */
  extractedText?: string;
  createdAt: string;
}

export interface WireKnowledgeChunk extends WireScope {
  id: string;
  documentId: string;
  position: number;
  text: string;
  createdAt: string;
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

export interface WireResearch extends WireKnowledgeDocument {
  projectId: string; // required for research
}

export interface WireResearchChunk extends WireScope {
  id: string;
  researchId: string;
  position: number;
  text: string;
  createdAt: string;
}

export interface WireIntention extends WireScope {
  id: string;
  content: string;
  status: IntentionStatus;
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

export interface WireArchivedRevision {
  id: string;
  originalId: string;
  originalKind: MemoryKind;
  snapshot: unknown; // parsed JSON for caller convenience
  archivedAt: string;
  reason: string;
  archivedBy?: string;
}

export interface WireAuditEvent {
  id: string;
  kind: AuditEventKind;
  targetId: string;
  targetKind: MemoryKind;
  payload: unknown;
  at: string;
  actor?: string;
}

export interface WireWorkingStateEntry {
  scope: {
    agentId: string;
    sessionId?: string;
    userId?: string;
    projectId?: string;
  };
  key: string;
  value: unknown;
  expiresAt: string | null;
  updatedAt: string;
}

// --- Mappers ---------------------------------------------------------------

function pickScope(item: { projectId?: string; userId?: string }): WireScope {
  const out: WireScope = {};
  if (item.projectId) out.projectId = item.projectId;
  if (item.userId) out.userId = item.userId;
  return out;
}

export function toWireFact(
  f: Fact & { originAgentId?: string | null; originSessionId?: string | null },
): WireFact {
  return {
    id: f.id,
    content: f.content,
    category: f.category,
    confidence: f.confidence,
    importance: f.importance,
    validFrom: f.validFrom.toISOString(),
    validTo: f.validTo ? f.validTo.toISOString() : null,
    recordedAt: f.recordedAt.toISOString(),
    entities: f.entityIds,
    supersedes: f.supersedesFactId,
    sourceEpisodeId: f.sourceEpisodeId,
    agentId: f.agentId,
    sessionId: f.sessionId,
    refCount: f.referenceCount,
    originAgentId: f.originAgentId,
    originSessionId: f.originSessionId,
    ...pickScope(f),
  };
}

export function toWireChunk(c: Chunk): WireChunk {
  return {
    id: c.id,
    episodeId: c.episodeId,
    position: c.position,
    text: c.text,
    createdAt: c.createdAt.toISOString(),
    ...pickScope(c),
  };
}

export function toWirePreference(p: Preference): WirePreference {
  return {
    key: p.key,
    value: p.value,
    confidence: p.confidence,
    validFrom: p.validFrom.toISOString(),
    validTo: p.validTo ? p.validTo.toISOString() : null,
    ...pickScope(p),
  };
}

export function toWireEntity(e: Entity): { id: string; name: string; type: string } {
  return { id: e.id, name: e.name, type: e.type };
}

export function toWireObservation(o: Observation): WireObservation {
  return {
    id: o.id,
    agentId: o.agentId,
    sessionId: o.sessionId,
    content: o.content,
    recordedAt: o.recordedAt.toISOString(),
    expiresAt: o.expiresAt.toISOString(),
    ...pickScope(o),
  };
}

export function toWireInsight(i: Insight): WireInsight {
  return {
    id: i.id,
    content: i.content,
    promotedFromFactIds: i.promotedFromFactIds,
    createdAt: i.createdAt.toISOString(),
    ...pickScope(i),
  };
}

export function toWireKnowledgeDocument(
  d: KnowledgeDocument,
  attachments?: KnowledgeAttachment[],
  attachmentTexts?: Record<string, string>,
): WireKnowledgeDocument {
  return {
    id: d.id,
    title: d.title,
    source: d.source,
    sourceUri: d.sourceUri,
    content: d.content,
    contentHash: d.contentHash,
    summary: d.summary,
    tags: d.tags,
    expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    ...(attachments
      ? {
          attachments: attachments.map((a) =>
            toWireKnowledgeAttachment(a, attachmentTexts?.[a.id]),
          ),
        }
      : {}),
    ...pickScope(d),
  };
}

export function toWireKnowledgeAttachment(
  a: KnowledgeAttachment,
  extractedText?: string,
): WireKnowledgeAttachment {
  return {
    id: a.id,
    documentId: a.documentId,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    sha256: a.sha256,
    blobId: a.blobId,
    extractionStatus: a.extractionStatus,
    extractedChars: a.extractedChars,
    detail: a.detail,
    ...(extractedText ? { extractedText } : {}),
    createdAt: a.createdAt.toISOString(),
    ...pickScope(a),
  };
}

export function toWireKnowledgeChunk(c: KnowledgeChunk): WireKnowledgeChunk {
  return {
    id: c.id,
    documentId: c.documentId,
    position: c.position,
    text: c.text,
    createdAt: c.createdAt.toISOString(),
    ...pickScope(c),
  };
}

export function toWireResearchChunk(c: ResearchChunk): WireResearchChunk {
  return {
    id: c.id,
    researchId: c.researchId,
    position: c.position,
    text: c.text,
    createdAt: c.createdAt.toISOString(),
    ...pickScope(c),
  };
}

export function toWireProcedure(p: Procedure): WireProcedure {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    content: p.content,
    whenToUse: p.whenToUse,
    successRate: p.successRate,
    invocationCount: p.invocationCount,
    lastSuccessAt: p.lastSuccessAt ? p.lastSuccessAt.toISOString() : null,
    expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    ...pickScope(p),
  };
}

export function toWireIntention(i: Intention): WireIntention {
  return {
    id: i.id,
    content: i.content,
    status: i.status,
    dueAt: i.dueAt ? i.dueAt.toISOString() : null,
    triggerHint: i.triggerHint,
    recurring: i.recurring,
    schedule: i.schedule,
    fireCount: i.fireCount,
    lastFiredAt: i.lastFiredAt ? i.lastFiredAt.toISOString() : null,
    validFrom: i.validFrom.toISOString(),
    validTo: i.validTo ? i.validTo.toISOString() : null,
    createdAt: i.createdAt.toISOString(),
    completedAt: i.completedAt ? i.completedAt.toISOString() : null,
    importance: i.importance,
    ...(i.agentId ? { agentId: i.agentId } : {}),
    ...(i.sessionId ? { sessionId: i.sessionId } : {}),
    ...(i.sourceEpisodeId ? { sourceEpisodeId: i.sourceEpisodeId } : {}),
    ...(i.sourceFactId ? { sourceFactId: i.sourceFactId } : {}),
    ...pickScope(i),
  };
}

export function toWireResearch(r: Research): WireResearch {
  return {
    ...toWireKnowledgeDocument(r),
    projectId: r.projectId,
  };
}

export function toWireArchivedRevision(a: ArchivedRevision): WireArchivedRevision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(a.snapshot);
  } catch {
    parsed = a.snapshot;
  }
  return {
    id: a.id,
    originalId: a.originalId,
    originalKind: a.originalKind,
    snapshot: parsed,
    archivedAt: a.archivedAt.toISOString(),
    reason: a.reason,
    archivedBy: a.archivedBy,
  };
}

export function toWireAuditEvent(e: AuditEvent): WireAuditEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(e.payload);
  } catch {
    parsed = e.payload;
  }
  return {
    id: e.id,
    kind: e.kind,
    targetId: e.targetId,
    targetKind: e.targetKind,
    payload: parsed,
    at: e.at.toISOString(),
    actor: e.actor,
  };
}

export function toWireWorkingStateEntry(w: WorkingStateEntry): WireWorkingStateEntry {
  return {
    scope: {
      agentId: w.scope.agentId,
      sessionId: w.scope.sessionId,
      userId: w.scope.userId,
      projectId: w.scope.projectId,
    },
    key: w.key,
    value: w.value,
    expiresAt: w.expiresAt ? w.expiresAt.toISOString() : null,
    updatedAt: w.updatedAt.toISOString(),
  };
}
