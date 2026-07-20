// Wire shapes consumed by the dashboard. Hand-mirrored from the backend's
// Zod schemas (src/http/wire-schemas-dashboard.ts and wire-schemas.ts).
// Keeping this small and dependency-free — we don't pull the backend's
// schemas in because they import server-only modules.

export type MemoryKind =
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
  | 'intention';

export type FactSort = 'refs' | 'importance' | 'recent';

export type TimelineBucket = 'day' | 'hour';

export interface WireFact {
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
  refCount?: number;
  projectId?: string;
  userId?: string;
}

export interface StatsPayload {
  kindCounts: Array<{ kind: MemoryKind; count: number }>;
  facts: { active: number; superseded: number; softDeleted: number };
  entities: number;
  observations: { active: number; expired: number };
  supersedeEdges: number;
  lastDream: {
    id: string;
    completedAt: string;
    durationMs: number;
    factsCreated: number;
    factsSuperseded: number;
    insightsPromoted: number;
  } | null;
}

export interface TimelinePayload {
  bucket: TimelineBucket;
  kind: MemoryKind;
  since: string;
  points: Array<{ bucket: string; count: number }>;
}

export interface TopFact extends WireFact {
  refCount: number;
  lastReferencedAt: string | null;
  // Ebbinghaus retention (0..1] computed server-side at response time.
  retention: number;
}

export interface TopFactsPayload {
  sort: FactSort;
  total: number;
  offset: number;
  items: TopFact[];
}

export interface FactCategoriesPayload {
  items: Array<{ category: string; count: number }>;
}

// Aggregate decay view over all active facts (Ebbinghaus forgetting curve).
export interface RetentionPoint {
  retention: number;
  daysSinceLastReference: number;
  importance: number;
  referenceCount: number;
  exempt: boolean;
}

export interface AtRiskFact {
  id: string;
  content: string;
  importance: number;
  referenceCount: number;
  lastReferencedAt: string | null;
  daysSinceLastReference: number;
  retention: number;
  prunable: boolean;
}

export interface RetentionPayload {
  generatedAt: string;
  totalActive: number;
  truncated: boolean;
  policy: { importanceExempt: number; minWindowDays: number; retentionFloor: number };
  summary: { exempt: number; withinWindow: number; atRisk: number; prunable: number };
  histogram: Array<{ bin: number; count: number }>;
  sample: RetentionPoint[];
  atRisk: AtRiskFact[];
}

export interface TopEntity {
  id: string;
  name: string;
  type: string;
  factCount: number;
}

export interface TopEntitiesPayload {
  items: TopEntity[];
}

export interface EntityTypesPayload {
  items: Array<{ type: string; count: number }>;
}

export interface EpisodeOriginsPayload {
  items: Array<{ origin: string; count: number }>;
}

export interface GraphSearchHit {
  id: string;
  kind: string;
  label: string;
  snippet?: string;
  score: number;
}

export interface GraphSearchPayload {
  q: string;
  results: GraphSearchHit[];
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  props: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
}

export interface GraphNeighborhoodPayload {
  rootId: string;
  depth: 1 | 2;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Slim node shape for the whole-graph cosmos view — no props; the inspector
// fetches /graph/neighborhood for detail on demand.
export interface GraphOverviewNode {
  id: string;
  kind: string;
  label: string;
}

export interface GraphOverviewPayload {
  truncated: boolean;
  totalNodes: number;
  nodes: GraphOverviewNode[];
  edges: GraphEdge[];
}

export interface DreamRunSummary {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  durationMs: number | null;
  episodesProcessed: number;
  episodesFailed: number;
  factsCreated: number;
  factsSuperseded: number;
  factsPruned: number;
  factsMerged: number;
  insightsPromoted: number;
  extractionFailures: number;
  supersedeFailures: number;
  relationsCreated: number;
  synonymsCreated: number;
  entitiesReembedded: number;
  error?: string;
}

export interface DreamRunsPayload {
  items: DreamRunSummary[];
}

export interface SupersedeChainPayload {
  factId: string;
  chain: WireFact[];
}

export type AuditEventKind =
  | 'create'
  | 'update'
  | 'supersede'
  | 'soft_delete'
  | 'prune'
  | 'promote'
  | 'archive'
  | 'merge';

export interface AuditEvent {
  id: string;
  kind: AuditEventKind;
  targetId: string;
  targetKind: string;
  payload: unknown;
  at: string;
  actor?: string;
}

export interface AuditPayload {
  items: AuditEvent[];
}

// The node kinds that retain a full body on-node, and so have a markdown
// projection in the vault.
export type NarrativeKind = 'research' | 'knowledge_document';

// The vault's markdown projection of a research / knowledge document, served
// inside the standard envelope by /dashboard/api/*/markdown.
export interface NarrativeMarkdownPayload {
  markdown: string;
  filename: string;
}
