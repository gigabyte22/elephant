// Composes DashboardRepository queries into the wire-shaped payloads the
// dashboard SPA consumes. Pure orchestration — no state of its own, no LLM
// or embedder dependencies.

import type { ManagedTransaction } from 'neo4j-driver';
import { read } from '../config/neo4j.ts';
import type { MemoryKind } from '../models/types.ts';
import { type WireFact, toWireFact } from '../models/wire.ts';
import {
  DashboardRepository,
  type GraphEdgeRow,
  type GraphNodeRow,
  type ScopeFilter,
} from '../repositories/DashboardRepository.ts';
import { DreamRunRepository } from '../repositories/DreamRunRepository.ts';
import { type PruneConfig, ebbinghausRetention, shouldPrune } from '../utils/decay.ts';
import { truncate } from '../utils/truncate.ts';

export interface ScopeInput {
  agentId?: string;
  sessionId?: string;
  projectId?: string;
  userId?: string;
}

function toScopeFilter(scope: ScopeInput): ScopeFilter {
  // agentId / sessionId aren't applied to aggregate queries in v1 — see
  // DashboardRepository for the rationale. Accepting them on the API keeps
  // the dashboard's global filter bar consistent and forward-compatible.
  return {
    projectId: scope.projectId,
    userId: scope.userId,
  };
}

export interface DashboardService {
  stats(scope: ScopeInput): Promise<StatsPayload>;
  timeline(input: {
    kind: MemoryKind;
    bucket: 'day' | 'hour';
    days: number;
    scope: ScopeInput;
  }): Promise<TimelinePayload>;
  topFacts(input: {
    sort: 'refs' | 'importance' | 'recent';
    limit: number;
    offset?: number;
    q?: string;
    category?: string;
    scope: ScopeInput;
  }): Promise<TopFactsPayload>;
  factCategories(scope: ScopeInput): Promise<FactCategoriesPayload>;
  retention(scope: ScopeInput): Promise<RetentionPayload>;
  topEntities(input: { limit: number; scope: ScopeInput }): Promise<TopEntitiesPayload>;
  entityTypes(): Promise<EntityTypesPayload>;
  episodeOrigins(scope: ScopeInput): Promise<EpisodeOriginsPayload>;
  documents(input: {
    kind?: 'research' | 'knowledge_document';
    q?: string;
    sort: 'recent' | 'created' | 'title';
    limit: number;
    offset: number;
    scope: ScopeInput;
  }): Promise<DocumentsPayload>;
  graphSearch(input: { q: string; limit: number }): Promise<GraphSearchPayload>;
  graphNeighborhood(input: {
    nodeId: string;
    depth: 1 | 2;
    maxNodes: number;
  }): Promise<GraphNeighborhoodPayload>;
  graphOverview(input: {
    maxNodes: number;
    scope: ScopeInput;
    excludeKinds?: string[];
  }): Promise<GraphOverviewPayload>;
  dreams(input: { limit: number }): Promise<DreamRunsPayload>;
  supersedeChain(input: { factId: string }): Promise<SupersedeChainPayload>;
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
  bucket: 'day' | 'hour';
  kind: MemoryKind;
  since: string;
  points: Array<{ bucket: string; count: number }>;
}

export type TopFactItem = WireFact & {
  refCount: number;
  lastReferencedAt: string | null;
  retention: number;
};

export interface TopFactsPayload {
  sort: 'refs' | 'importance' | 'recent';
  total: number;
  offset: number;
  items: TopFactItem[];
}

export interface FactCategoriesPayload {
  items: Array<{ category: string; count: number }>;
}

export interface RetentionPayload {
  generatedAt: string;
  totalActive: number;
  truncated: boolean;
  policy: { importanceExempt: number; minWindowDays: number; retentionFloor: number };
  summary: { exempt: number; withinWindow: number; atRisk: number; prunable: number };
  histogram: Array<{ bin: number; count: number }>;
  sample: Array<{
    retention: number;
    daysSinceLastReference: number;
    importance: number;
    referenceCount: number;
    exempt: boolean;
  }>;
  atRisk: Array<{
    id: string;
    content: string;
    importance: number;
    referenceCount: number;
    lastReferencedAt: string | null;
    daysSinceLastReference: number;
    retention: number;
    prunable: boolean;
  }>;
}

export interface TopEntitiesPayload {
  items: Array<{ id: string; name: string; type: string; factCount: number }>;
}

export interface EntityTypesPayload {
  items: Array<{ type: string; count: number }>;
}

export interface EpisodeOriginsPayload {
  items: Array<{ origin: string; count: number }>;
}

export interface DocumentItem {
  id: string;
  kind: 'research' | 'knowledge_document';
  title: string;
  summary: string;
  source: string;
  tags: string[];
  projectId?: string;
  userId?: string;
  hasContent: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface DocumentsPayload {
  sort: 'recent' | 'created' | 'title';
  total: number;
  offset: number;
  items: DocumentItem[];
}

export interface GraphSearchPayload {
  q: string;
  results: Array<{
    id: string;
    kind: string;
    label: string;
    snippet?: string;
    score: number;
  }>;
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

// Slim node shape for the whole-graph cosmos view — no props payload, the
// inspector fetches the neighborhood endpoint for details on demand.
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

export interface DreamRunsPayload {
  items: Array<{
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
  }>;
}

export interface SupersedeChainPayload {
  factId: string;
  chain: WireFact[];
}

// --- Service implementation -----------------------------------------------

// Row cap for the retention aggregate — bounds the working set on very large
// graphs; `truncated` on the payload flags when it was hit.
const RETENTION_ROW_CAP = 10_000;
const RETENTION_SAMPLE_MAX = 500;
const RETENTION_AT_RISK_MAX = 50;
// Non-exempt facts below this retention (and past the window) count "at risk" —
// a wider net than the prune floor so the dashboard warns before facts drop.
const AT_RISK_RETENTION = 0.2;

const MS_PER_DAY = 86_400_000;

function daysSince(now: number, lastReferencedAt: Date | null, recordedAt: Date): number {
  const ref = lastReferencedAt ?? recordedAt;
  return Math.max(0, (now - ref.getTime()) / MS_PER_DAY);
}

export interface DashboardServiceConfig {
  // Prune policy the dreamer actually runs with, so retention readouts match.
  prune?: PruneConfig;
}

export function createDashboardService(config: DashboardServiceConfig = {}): DashboardService {
  const prunePolicy = {
    importanceExempt: config.prune?.importanceExempt ?? 0.75,
    minWindowDays: config.prune?.minWindowDays ?? 30,
    retentionFloor: config.prune?.retentionFloor ?? 0.05,
  };
  return {
    async stats(scope) {
      return read(async (tx) => buildStats(tx, scope));
    },

    async timeline(input) {
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
      return read(async (tx) => {
        const points = await DashboardRepository.timeline(tx, {
          kind: input.kind,
          bucket: input.bucket,
          since,
          scope: toScopeFilter(input.scope),
        });
        return {
          bucket: input.bucket,
          kind: input.kind,
          since: since.toISOString(),
          points,
        };
      });
    },

    async topFacts(input) {
      return read(async (tx) => {
        const scope = toScopeFilter(input.scope);
        const offset = input.offset ?? 0;
        const [facts, total] = await Promise.all([
          DashboardRepository.topFacts(tx, {
            sort: input.sort,
            limit: input.limit,
            offset,
            q: input.q,
            category: input.category,
            scope,
          }),
          DashboardRepository.countFacts(tx, { q: input.q, category: input.category, scope }),
        ]);
        const now = Date.now();
        return {
          sort: input.sort,
          total,
          offset,
          items: facts.map((f) => ({
            ...toWireFact(f),
            // Force-populate refCount + lastReferencedAt for the dashboard wire shape.
            refCount: f.referenceCount,
            lastReferencedAt: f.lastReferencedAt ? f.lastReferencedAt.toISOString() : null,
            retention: ebbinghausRetention({
              daysSinceLastReference: daysSince(now, f.lastReferencedAt, f.recordedAt),
              referenceCount: f.referenceCount,
              importance: f.importance,
            }),
          })),
        };
      });
    },

    async factCategories(scope) {
      return read(async (tx) => {
        const rows = await DashboardRepository.factCategories(tx, toScopeFilter(scope));
        return {
          items: rows.map((r) => ({ category: r.category ?? 'uncategorized', count: r.count })),
        };
      });
    },

    async retention(scope) {
      return read(async (tx) => {
        const filter = toScopeFilter(scope);
        const [rows, totalActive] = await Promise.all([
          DashboardRepository.factRetentionRows(tx, { scope: filter, cap: RETENTION_ROW_CAP }),
          DashboardRepository.countFacts(tx, { scope: filter }),
        ]);
        const now = Date.now();
        const points = rows.map((row) => {
          const days = daysSince(now, row.lastReferencedAt, row.recordedAt);
          const retention = ebbinghausRetention({
            daysSinceLastReference: days,
            referenceCount: row.referenceCount,
            importance: row.importance,
          });
          const exempt = row.importance >= prunePolicy.importanceExempt;
          return {
            ...row,
            daysSinceLastReference: days,
            retention,
            exempt,
            prunable: shouldPrune({
              importance: row.importance,
              daysSinceLastReference: days,
              referenceCount: row.referenceCount,
              config: prunePolicy,
            }),
          };
        });

        const atRiskOf = (p: (typeof points)[number]): boolean =>
          !p.exempt &&
          p.daysSinceLastReference >= prunePolicy.minWindowDays &&
          p.retention < AT_RISK_RETENTION;
        // Filter once; the summary count and the capped list below share it.
        const atRiskPoints = points.filter(atRiskOf);

        const histogram = Array.from({ length: 10 }, (_, i) => ({ bin: i / 10, count: 0 }));
        for (const p of points) {
          const idx = Math.min(9, Math.floor(p.retention * 10));
          const cell = histogram[idx];
          if (cell) cell.count += 1;
        }

        // Uniform stride keeps the scatter representative rather than biased
        // toward whichever rows the query returned first.
        const stride = Math.max(1, Math.ceil(points.length / RETENTION_SAMPLE_MAX));
        const sample = points
          .filter((_, i) => i % stride === 0)
          .slice(0, RETENTION_SAMPLE_MAX)
          .map((p) => ({
            retention: p.retention,
            daysSinceLastReference: p.daysSinceLastReference,
            importance: p.importance,
            referenceCount: p.referenceCount,
            exempt: p.exempt,
          }));

        const atRisk = [...atRiskPoints]
          .sort((a, b) => a.retention - b.retention)
          .slice(0, RETENTION_AT_RISK_MAX)
          .map((p) => ({
            id: p.id,
            content: truncate(p.content, 120),
            importance: p.importance,
            referenceCount: p.referenceCount,
            lastReferencedAt: p.lastReferencedAt ? p.lastReferencedAt.toISOString() : null,
            daysSinceLastReference: p.daysSinceLastReference,
            retention: p.retention,
            prunable: p.prunable,
          }));

        return {
          generatedAt: new Date().toISOString(),
          totalActive,
          truncated: totalActive > rows.length,
          policy: prunePolicy,
          summary: {
            exempt: points.filter((p) => p.exempt).length,
            withinWindow: points.filter(
              (p) => !p.exempt && p.daysSinceLastReference < prunePolicy.minWindowDays,
            ).length,
            atRisk: atRiskPoints.length,
            prunable: points.filter((p) => p.prunable).length,
          },
          histogram,
          sample,
          atRisk,
        };
      });
    },

    async topEntities(input) {
      return read(async (tx) => {
        const items = await DashboardRepository.topEntities(tx, {
          limit: input.limit,
          scope: toScopeFilter(input.scope),
        });
        return { items };
      });
    },

    async entityTypes() {
      return read(async (tx) => {
        const items = await DashboardRepository.entityTypeCounts(tx);
        return { items };
      });
    },

    async episodeOrigins(scope) {
      return read(async (tx) => {
        const items = await DashboardRepository.episodeOriginCounts(tx, toScopeFilter(scope));
        return { items };
      });
    },

    async documents(input) {
      return read(async (tx) => {
        const scope = toScopeFilter(input.scope);
        const [rows, total] = await Promise.all([
          DashboardRepository.listDocuments(tx, { ...input, scope }),
          DashboardRepository.countDocuments(tx, { kind: input.kind, q: input.q, scope }),
        ]);
        return {
          sort: input.sort,
          total,
          offset: input.offset,
          items: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            title: r.title,
            summary: r.summary,
            source: r.source,
            tags: r.tags,
            ...(r.projectId !== null && { projectId: r.projectId }),
            ...(r.userId !== null && { userId: r.userId }),
            hasContent: r.hasContent,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
            ...(r.expiresAt !== null && { expiresAt: r.expiresAt.toISOString() }),
          })),
        };
      });
    },

    async graphSearch(input) {
      return read(async (tx) => {
        const perSource = Math.max(5, Math.ceil(input.limit / 2));
        const [facts, chunks, knowledge, docs, research, procs, entities] = await Promise.all([
          DashboardRepository.searchFacts(tx, input.q, perSource).catch(() => []),
          DashboardRepository.searchChunks(tx, input.q, perSource).catch(() => []),
          DashboardRepository.searchKnowledgeChunks(tx, input.q, perSource).catch(() => []),
          DashboardRepository.searchKnowledgeDocuments(tx, input.q, perSource).catch(() => []),
          DashboardRepository.searchResearch(tx, input.q, perSource).catch(() => []),
          DashboardRepository.searchProcedures(tx, input.q, perSource).catch(() => []),
          DashboardRepository.searchEntities(tx, input.q, perSource),
        ]);
        const merged = [
          ...facts,
          ...chunks,
          ...knowledge,
          ...docs,
          ...research,
          ...procs,
          ...entities,
        ]
          .sort((a, b) => b.score - a.score)
          .slice(0, input.limit);
        return { q: input.q, results: merged };
      });
    },

    async graphNeighborhood(input) {
      return read(async (tx) => composeNeighborhood(tx, input));
    },

    async graphOverview(input) {
      return read(async (tx) => {
        const scope = toScopeFilter(input.scope);
        const [rows, totalNodes] = await Promise.all([
          DashboardRepository.overviewNodes(tx, {
            maxNodes: input.maxNodes,
            scope,
            excludeKinds: input.excludeKinds,
          }),
          DashboardRepository.overviewNodeCount(tx, scope, input.excludeKinds),
        ]);
        const ids = rows.map((r) => r.id);
        const maxEdges = Math.min(input.maxNodes * 10, 15_000);
        const edgeRows = ids.length
          ? await DashboardRepository.overviewEdges(tx, ids, maxEdges)
          : [];
        // Parallel same-type relationships collapse onto one synthetic id.
        const edges = new Map<string, GraphEdge>();
        for (const e of edgeRows) {
          const ge = toGraphEdge(e);
          if (!edges.has(ge.id)) edges.set(ge.id, ge);
        }
        const nodes: GraphOverviewNode[] = rows.map((row) => {
          const kind = pickPrimaryKind(row.labels, row.props.kind);
          return { id: row.id, kind, label: pickLabel(row.props, kind) };
        });
        return {
          truncated: totalNodes > nodes.length,
          totalNodes,
          nodes,
          edges: [...edges.values()],
        };
      });
    },

    async dreams(input) {
      return read(async (tx) => {
        const rows = await DashboardRepository.listDreamRuns(tx, input.limit);
        return {
          items: rows.map((r) => ({
            id: r.id,
            startedAt: r.startedAt.toISOString(),
            completedAt: r.completedAt ? r.completedAt.toISOString() : null,
            status: r.status as 'running' | 'completed' | 'failed',
            durationMs: r.completedAt ? r.completedAt.getTime() - r.startedAt.getTime() : null,
            episodesProcessed: r.episodesProcessed,
            episodesFailed: r.episodesFailed,
            factsCreated: r.factsCreated,
            factsSuperseded: r.factsSuperseded,
            factsPruned: r.factsPruned,
            factsMerged: r.factsMerged,
            insightsPromoted: r.insightsPromoted,
            extractionFailures: r.extractionFailures,
            supersedeFailures: r.supersedeFailures,
            relationsCreated: r.relationsCreated,
            synonymsCreated: r.synonymsCreated,
            entitiesReembedded: r.entitiesReembedded,
            error: r.error,
          })),
        };
      });
    },

    async supersedeChain(input) {
      return read(async (tx) => {
        const chain = await DashboardRepository.supersedeChain(tx, input.factId);
        return {
          factId: input.factId,
          chain: chain.map(toWireFact),
        };
      });
    },
  };
}

async function buildStats(tx: ManagedTransaction, scope: ScopeInput): Promise<StatsPayload> {
  const filter = toScopeFilter(scope);
  const [kindCounts, factCounts, entityCount, obsCounts, supersedeEdges, lastDream] =
    await Promise.all([
      DashboardRepository.kindCounts(tx, filter),
      DashboardRepository.factCounts(tx, filter),
      DashboardRepository.entityCount(tx),
      DashboardRepository.observationCounts(tx, filter),
      DashboardRepository.supersedeEdgeCount(tx),
      DreamRunRepository.getLastCompleted(tx),
    ]);
  return {
    kindCounts,
    facts: factCounts,
    entities: entityCount,
    observations: obsCounts,
    supersedeEdges,
    lastDream: lastDream?.completedAt
      ? {
          id: lastDream.id,
          completedAt: lastDream.completedAt.toISOString(),
          durationMs: lastDream.completedAt.getTime() - lastDream.startedAt.getTime(),
          factsCreated: lastDream.factsCreated,
          factsSuperseded: lastDream.factsSuperseded,
          insightsPromoted: lastDream.insightsPromoted,
        }
      : null,
  };
}

// --- Graph node / edge mapping --------------------------------------------

const MEMORY_LABELS = new Set([
  'Fact',
  'Episode',
  'Chunk',
  'Preference',
  'Insight',
  'Observation',
  'KnowledgeDocument',
  'KnowledgeChunk',
  'Procedure',
  'Research',
  'Entity',
  'ArchivedRevision',
  'AuditEvent',
  'DreamRun',
  'SystemState',
  'WorkingState',
]);

function pickPrimaryKind(labels: string[], explicitKind: unknown): string {
  if (typeof explicitKind === 'string' && explicitKind.length > 0) return explicitKind;
  const specific = labels.find((l) => l !== 'MemoryItem' && MEMORY_LABELS.has(l));
  return specific ? specific.toLowerCase() : 'unknown';
}

function pickLabel(row: Record<string, unknown>, kind: string): string {
  // Best-effort short display label per node kind.
  switch (kind) {
    case 'entity':
      return (row.name as string) ?? (row.id as string);
    case 'fact':
    case 'insight':
    case 'observation':
      return truncate((row.content as string) ?? '', 80);
    case 'chunk':
    case 'knowledge_chunk':
    case 'knowledgechunk':
      return truncate((row.text as string) ?? '', 80);
    case 'episode':
      return truncate((row.summary as string) ?? (row.rawTranscript as string) ?? '', 80);
    case 'knowledge_document':
    case 'knowledgedocument':
    case 'research':
      return (row.title as string) ?? truncate((row.summary as string) ?? '', 80);
    case 'procedure':
      return (row.name as string) ?? '';
    case 'preference':
      return `${row.key as string} = ${truncate((row.value as string) ?? '', 40)}`;
    default:
      return (row.id as string) ?? '';
  }
}

const STRIPPED_PROPS = new Set(['embedding', 'rawTranscript', 'payload']);
const TRUNCATED_PROPS = new Set(['content', 'text', 'summary', 'whenToUse']);

function sanitizeProps(
  raw: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_labels') continue;
    if (STRIPPED_PROPS.has(k)) continue;
    if (v === null || v === undefined) {
      out[k] = null;
      continue;
    }
    if (typeof v === 'string') {
      out[k] = TRUNCATED_PROPS.has(k) ? truncate(v, 200) : v;
      continue;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
      continue;
    }
    if (v instanceof Date) {
      out[k] = v.toISOString();
      continue;
    }
    if (typeof v === 'object' && 'toStandardDate' in (v as object)) {
      out[k] = (v as { toStandardDate(): Date }).toStandardDate().toISOString();
      continue;
    }
    // Arrays / nested objects flatten to a placeholder; the dashboard inspector
    // does not need to render these inline.
    out[k] = Array.isArray(v) ? `[${v.length} items]` : '[object]';
  }
  return out;
}

function toGraphNode(row: GraphNodeRow): GraphNode {
  const kind = pickPrimaryKind(row.labels, row.props.kind);
  return {
    id: row.id,
    kind,
    label: pickLabel(row.props, kind),
    props: sanitizeProps(row.props),
  };
}

function edgeKey(e: GraphEdgeRow): string {
  return `${e.type}:${e.source}->${e.target}`;
}

function toGraphEdge(e: GraphEdgeRow): GraphEdge {
  return { id: edgeKey(e), source: e.source, target: e.target, type: e.type };
}

async function composeNeighborhood(
  tx: ManagedTransaction,
  input: { nodeId: string; depth: 1 | 2; maxNodes: number },
): Promise<GraphNeighborhoodPayload> {
  const seenNodes = new Map<string, GraphNode>();
  const seenEdges = new Map<string, GraphEdge>();

  const root = await DashboardRepository.oneHop(tx, input.nodeId, input.maxNodes);
  if (!root.root) {
    return {
      rootId: input.nodeId,
      depth: input.depth,
      truncated: false,
      nodes: [],
      edges: [],
    };
  }
  seenNodes.set(root.root.id, toGraphNode(root.root));
  for (const n of root.nodes) seenNodes.set(n.id, toGraphNode(n));
  for (const e of root.edges) {
    const ge = toGraphEdge(e);
    seenEdges.set(ge.id, ge);
  }

  let truncated = false;
  if (input.depth === 2) {
    const frontier = root.nodes.map((n) => n.id);
    // Per-neighbor edge cap keeps the worst-case fanout in check.
    const perNeighborCap = Math.max(8, Math.floor(input.maxNodes / Math.max(frontier.length, 1)));
    for (const neighborId of frontier) {
      if (seenNodes.size >= input.maxNodes) {
        truncated = true;
        break;
      }
      const hop = await DashboardRepository.oneHop(tx, neighborId, perNeighborCap);
      for (const n of hop.nodes) {
        if (seenNodes.size >= input.maxNodes) {
          truncated = true;
          break;
        }
        if (!seenNodes.has(n.id)) seenNodes.set(n.id, toGraphNode(n));
      }
      for (const e of hop.edges) {
        const ge = toGraphEdge(e);
        if (!seenEdges.has(ge.id)) seenEdges.set(ge.id, ge);
      }
    }
  }

  return {
    rootId: input.nodeId,
    depth: input.depth,
    truncated,
    nodes: [...seenNodes.values()],
    edges: [...seenEdges.values()],
  };
}
