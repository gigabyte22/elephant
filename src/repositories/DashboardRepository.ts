// Read-only aggregation queries powering the built-in dashboard's
// introspection endpoints. Strictly Cypher + raw row mapping; the
// DashboardService composes these into wire-shaped payloads.
//
// Scope filtering is hard-match only (projectId / userId on :MemoryItem) —
// the dashboard exposes scope as a global filter, not a boost. agentId /
// sessionId are accepted by the API but currently not applied to aggregates
// (those axes only meaningfully scope Episodes/Observations).

import type { ManagedTransaction } from 'neo4j-driver';
import type { Fact, MemoryKind } from '../models/types.ts';
import { toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import { truncate } from '../utils/truncate.ts';
import { readScope } from './scope.ts';

export interface ScopeFilter {
  projectId?: string;
  userId?: string;
}

function buildScopeClause(
  alias: string,
  scope: ScopeFilter,
): { clause: string; params: Record<string, string> } {
  const parts: string[] = [];
  const params: Record<string, string> = {};
  if (scope.projectId) {
    parts.push(`${alias}.projectId = $scope_projectId`);
    params.scope_projectId = scope.projectId;
  }
  if (scope.userId) {
    parts.push(`${alias}.userId = $scope_userId`);
    params.scope_userId = scope.userId;
  }
  return { clause: parts.join(' AND '), params };
}

// Shared WHERE fragment for the facts ledger (top list + count): scope plus
// optional content substring and exact-category match. CONTAINS rather than
// the fulltext index so the three sorts stay stable under offset pagination.
function buildFactListFilter(input: {
  q?: string;
  category?: string;
  scope: ScopeFilter;
}): { clause: string; params: Record<string, string> } {
  const scoped = buildScopeClause('f', input.scope);
  const parts = scoped.clause ? [scoped.clause] : [];
  const params = { ...scoped.params };
  if (input.q) {
    parts.push('toLower(f.content) CONTAINS toLower($q)');
    params.q = input.q;
  }
  if (input.category) {
    parts.push('f.category = $category');
    params.category = input.category;
  }
  return { clause: parts.length ? `AND ${parts.join(' AND ')}` : '', params };
}

// --- Memory item kinds → timeline source mapping --------------------------
//
// Each :MemoryItem subtype has its own primary timestamp property. Mapped
// here once so timeline queries stay declarative.

const TIMELINE_SOURCES: Record<MemoryKind, { label: string; ts: string }> = {
  fact: { label: 'Fact', ts: 'recordedAt' },
  episode: { label: 'Episode', ts: 'timestamp' },
  chunk: { label: 'Chunk', ts: 'createdAt' },
  preference: { label: 'Preference', ts: 'validFrom' },
  insight: { label: 'Insight', ts: 'createdAt' },
  observation: { label: 'Observation', ts: 'recordedAt' },
  knowledge_document: { label: 'KnowledgeDocument', ts: 'createdAt' },
  knowledge_chunk: { label: 'KnowledgeChunk', ts: 'createdAt' },
  procedure: { label: 'Procedure', ts: 'createdAt' },
  research: { label: 'Research', ts: 'createdAt' },
  intention: { label: 'Intention', ts: 'createdAt' },
};

function toFactRow(node: Record<string, unknown>, entityIds: string[]): Fact {
  return {
    id: node.id as string,
    content: node.content as string,
    category: (node.category as string | undefined) ?? undefined,
    confidence: node.confidence as number,
    importance: node.importance as number,
    validFrom: toJsDate(node.validFrom),
    validTo: toJsDateOrNull(node.validTo),
    recordedAt: toJsDate(node.recordedAt),
    embedding: [],
    entityIds,
    supersedesFactId: (node.supersedesFactId as string | undefined) ?? undefined,
    sourceEpisodeId: (node.sourceEpisodeId as string | undefined) ?? undefined,
    referenceCount: (node.referenceCount as number | undefined) ?? 0,
    lastReferencedAt: toJsDateOrNull(node.lastReferencedAt),
    ...readScope(node),
  };
}

// --- Public types ---------------------------------------------------------

export interface KindCount {
  kind: MemoryKind;
  count: number;
}

export interface FactCounts {
  active: number;
  superseded: number;
  softDeleted: number;
}

export interface ObservationCounts {
  active: number;
  expired: number;
}

export interface TimelinePoint {
  bucket: string; // ISO date (day) or ISO datetime (hour)
  count: number;
}

export interface TopFactRow extends Fact {
  referenceCount: number;
  lastReferencedAt: Date | null;
}

export interface TopEntityRow {
  id: string;
  name: string;
  type: string;
  factCount: number;
}

export interface GraphNodeRow {
  id: string;
  labels: string[];
  props: Record<string, unknown>;
}

export interface GraphEdgeRow {
  source: string;
  target: string;
  type: string;
}

export interface GraphSearchHit {
  id: string;
  kind: string;
  label: string;
  snippet?: string;
  score: number;
}

export const DashboardRepository = {
  async kindCounts(tx: ManagedTransaction, scope: ScopeFilter): Promise<KindCount[]> {
    const { clause, params } = buildScopeClause('m', scope);
    const where = clause ? `WHERE ${clause}` : '';
    const result = await tx.run(
      `MATCH (m:MemoryItem) ${where}
       RETURN m.kind AS kind, count(*) AS count
       ORDER BY count DESC`,
      params,
    );
    return result.records.map((r) => ({
      kind: r.get('kind') as MemoryKind,
      count: r.get('count') as number,
    }));
  },

  async factCounts(tx: ManagedTransaction, scope: ScopeFilter): Promise<FactCounts> {
    const { clause, params } = buildScopeClause('f', scope);
    const extra = clause ? `AND ${clause}` : '';
    const result = await tx.run(
      `MATCH (f:Fact)
       WHERE 1=1 ${extra}
       OPTIONAL MATCH (newer:Fact)-[:SUPERSEDES]->(f)
       WITH f, newer IS NOT NULL AS isSuperseded
       RETURN
         sum(CASE WHEN f.validTo IS NULL THEN 1 ELSE 0 END) AS active,
         sum(CASE WHEN f.validTo IS NOT NULL AND isSuperseded THEN 1 ELSE 0 END) AS superseded,
         sum(CASE WHEN f.validTo IS NOT NULL AND NOT isSuperseded THEN 1 ELSE 0 END) AS softDeleted`,
      params,
    );
    const row = result.records[0];
    if (!row) return { active: 0, superseded: 0, softDeleted: 0 };
    return {
      active: (row.get('active') as number) ?? 0,
      superseded: (row.get('superseded') as number) ?? 0,
      softDeleted: (row.get('softDeleted') as number) ?? 0,
    };
  },

  async entityCount(tx: ManagedTransaction): Promise<number> {
    const result = await tx.run('MATCH (e:Entity) RETURN count(e) AS count');
    return (result.records[0]?.get('count') as number | undefined) ?? 0;
  },

  async observationCounts(tx: ManagedTransaction, scope: ScopeFilter): Promise<ObservationCounts> {
    const { clause, params } = buildScopeClause('o', scope);
    const extra = clause ? `AND ${clause}` : '';
    const result = await tx.run(
      `MATCH (o:Observation)
       WHERE 1=1 ${extra}
       RETURN
         sum(CASE WHEN o.expiresAt > datetime() THEN 1 ELSE 0 END) AS active,
         sum(CASE WHEN o.expiresAt <= datetime() THEN 1 ELSE 0 END) AS expired`,
      params,
    );
    const row = result.records[0];
    if (!row) return { active: 0, expired: 0 };
    return {
      active: (row.get('active') as number) ?? 0,
      expired: (row.get('expired') as number) ?? 0,
    };
  },

  async supersedeEdgeCount(tx: ManagedTransaction): Promise<number> {
    const result = await tx.run('MATCH ()-[r:SUPERSEDES]->() RETURN count(r) AS count');
    return (result.records[0]?.get('count') as number | undefined) ?? 0;
  },

  async timeline(
    tx: ManagedTransaction,
    input: {
      kind: MemoryKind;
      bucket: 'day' | 'hour';
      since: Date;
      scope: ScopeFilter;
    },
  ): Promise<TimelinePoint[]> {
    const source = TIMELINE_SOURCES[input.kind];
    const scopeClause = buildScopeClause('n', input.scope);
    const extraScope = scopeClause.clause ? `AND ${scopeClause.clause}` : '';
    const bucketExpr =
      input.bucket === 'day' ? `date(n.${source.ts})` : `datetime.truncate('hour', n.${source.ts})`;
    // Interpolate label + property names — they're validated against an enum/map,
    // not user input, so this is safe.
    const cypher = `
      MATCH (n:${source.label})
      WHERE n.${source.ts} >= datetime($since)
      ${extraScope}
      WITH ${bucketExpr} AS bucket, count(*) AS count
      RETURN toString(bucket) AS bucket, count
      ORDER BY bucket ASC`;
    const result = await tx.run(cypher, {
      since: input.since.toISOString(),
      ...scopeClause.params,
    });
    return result.records.map((r) => ({
      bucket: r.get('bucket') as string,
      count: r.get('count') as number,
    }));
  },

  async topFacts(
    tx: ManagedTransaction,
    input: {
      sort: 'refs' | 'importance' | 'recent';
      limit: number;
      offset?: number;
      q?: string;
      category?: string;
      scope: ScopeFilter;
    },
  ): Promise<TopFactRow[]> {
    const filter = buildFactListFilter(input);
    const orderBy =
      input.sort === 'refs'
        ? 'coalesce(f.referenceCount, 0) DESC, f.recordedAt DESC'
        : input.sort === 'importance'
          ? 'f.importance DESC, f.recordedAt DESC'
          : 'f.recordedAt DESC';
    const result = await tx.run(
      `MATCH (f:Fact)
       WHERE f.validTo IS NULL ${filter.clause}
       OPTIONAL MATCH (e:Entity)-[:HAS_FACT]->(f)
       WITH f, collect(e.id) AS entityIds
       RETURN f {.*} AS f, entityIds
       ORDER BY ${orderBy}
       SKIP toInteger($offset)
       LIMIT toInteger($limit)`,
      { limit: input.limit, offset: input.offset ?? 0, ...filter.params },
    );
    return result.records.map((r) => {
      const fact = toFactRow(r.get('f') as Record<string, unknown>, r.get('entityIds') as string[]);
      return {
        ...fact,
        referenceCount: fact.referenceCount ?? 0,
        lastReferencedAt: fact.lastReferencedAt ?? null,
      };
    });
  },

  async countFacts(
    tx: ManagedTransaction,
    input: { q?: string; category?: string; scope: ScopeFilter },
  ): Promise<number> {
    const filter = buildFactListFilter(input);
    const result = await tx.run(
      `MATCH (f:Fact)
       WHERE f.validTo IS NULL ${filter.clause}
       RETURN count(f) AS count`,
      filter.params,
    );
    return (result.records[0]?.get('count') as number | undefined) ?? 0;
  },

  async factCategories(
    tx: ManagedTransaction,
    scope: ScopeFilter,
  ): Promise<Array<{ category: string | null; count: number }>> {
    const { clause, params } = buildScopeClause('f', scope);
    const extra = clause ? `AND ${clause}` : '';
    const result = await tx.run(
      `MATCH (f:Fact)
       WHERE f.validTo IS NULL ${extra}
       RETURN f.category AS category, count(*) AS count
       ORDER BY count DESC`,
      params,
    );
    return result.records.map((r) => ({
      category: r.get('category') as string | null,
      count: r.get('count') as number,
    }));
  },

  // Minimal projection for retention math — the service maps rows through the
  // Ebbinghaus curve, so no embeddings or entity joins ride along.
  async factRetentionRows(
    tx: ManagedTransaction,
    input: { scope: ScopeFilter; cap: number },
  ): Promise<
    Array<{
      id: string;
      content: string;
      importance: number;
      referenceCount: number;
      lastReferencedAt: Date | null;
      recordedAt: Date;
    }>
  > {
    const { clause, params } = buildScopeClause('f', input.scope);
    const extra = clause ? `AND ${clause}` : '';
    const result = await tx.run(
      `MATCH (f:Fact)
       WHERE f.validTo IS NULL ${extra}
       RETURN f.id AS id, f.content AS content, f.importance AS importance,
              f.referenceCount AS referenceCount, f.lastReferencedAt AS lastReferencedAt,
              f.recordedAt AS recordedAt
       LIMIT toInteger($cap)`,
      { cap: input.cap, ...params },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      content: r.get('content') as string,
      importance: (r.get('importance') as number | null) ?? 0.5,
      referenceCount: (r.get('referenceCount') as number | null) ?? 0,
      lastReferencedAt: toJsDateOrNull(r.get('lastReferencedAt')),
      recordedAt: toJsDate(r.get('recordedAt')),
    }));
  },

  // Entities carry no scope (global connectors) — consistent with entityCount.
  async entityTypeCounts(tx: ManagedTransaction): Promise<Array<{ type: string; count: number }>> {
    const result = await tx.run(
      `MATCH (e:Entity)
       RETURN coalesce(e.type, 'unknown') AS type, count(*) AS count
       ORDER BY count DESC`,
    );
    return result.records.map((r) => ({
      type: r.get('type') as string,
      count: r.get('count') as number,
    }));
  },

  async episodeOriginCounts(
    tx: ManagedTransaction,
    scope: ScopeFilter,
  ): Promise<Array<{ origin: string; count: number }>> {
    const { clause, params } = buildScopeClause('n', scope);
    const extra = clause ? `AND ${clause}` : '';
    const result = await tx.run(
      `MATCH (n:Episode)
       WHERE 1=1 ${extra}
       RETURN coalesce(n.origin, 'user') AS origin, count(*) AS count
       ORDER BY count DESC`,
      params,
    );
    return result.records.map((r) => ({
      origin: r.get('origin') as string,
      count: r.get('count') as number,
    }));
  },

  async topEntities(
    tx: ManagedTransaction,
    input: { limit: number; scope: ScopeFilter },
  ): Promise<TopEntityRow[]> {
    const scopeClause = buildScopeClause('f', input.scope);
    const extra = scopeClause.clause ? `AND ${scopeClause.clause}` : '';
    const result = await tx.run(
      `MATCH (e:Entity)-[:HAS_FACT]->(f:Fact)
       WHERE f.validTo IS NULL ${extra}
       WITH e, count(f) AS factCount
       ORDER BY factCount DESC
       LIMIT toInteger($limit)
       RETURN e.id AS id, e.name AS name, e.type AS type, factCount`,
      { limit: input.limit, ...scopeClause.params },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      name: r.get('name') as string,
      type: r.get('type') as string,
      factCount: r.get('factCount') as number,
    }));
  },

  // --- Graph search ------------------------------------------------------
  //
  // Each source is queried independently; the service merges + sorts.
  // Returning a normalized row shape per source means the service can
  // concatenate without per-source branching.

  async searchFacts(tx: ManagedTransaction, q: string, limit: number): Promise<GraphSearchHit[]> {
    return runFulltextSearch(tx, {
      q,
      limit,
      index: 'fact_fulltext',
      label: 'Fact',
      textField: 'content',
      kind: 'fact',
    });
  },

  async searchChunks(tx: ManagedTransaction, q: string, limit: number): Promise<GraphSearchHit[]> {
    return runFulltextSearch(tx, {
      q,
      limit,
      index: 'chunk_fulltext',
      label: 'Chunk',
      textField: 'text',
      kind: 'chunk',
    });
  },

  async searchKnowledgeChunks(
    tx: ManagedTransaction,
    q: string,
    limit: number,
  ): Promise<GraphSearchHit[]> {
    return runFulltextSearch(tx, {
      q,
      limit,
      index: 'knowledge_chunk_fulltext',
      label: 'KnowledgeChunk',
      textField: 'text',
      kind: 'knowledge_chunk',
    });
  },

  async searchProcedures(
    tx: ManagedTransaction,
    q: string,
    limit: number,
  ): Promise<GraphSearchHit[]> {
    const result = await tx.run(
      `CALL db.index.fulltext.queryNodes('procedure_fulltext', $q) YIELD node, score
       WHERE node:Procedure
       RETURN node.id AS id, node.name AS name, node.whenToUse AS whenToUse, score
       LIMIT toInteger($limit)`,
      { q, limit },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      kind: 'procedure',
      label: r.get('name') as string,
      snippet: truncate(r.get('whenToUse') as string, 200),
      score: r.get('score') as number,
    }));
  },

  async searchEntities(
    tx: ManagedTransaction,
    q: string,
    limit: number,
  ): Promise<GraphSearchHit[]> {
    const result = await tx.run(
      `MATCH (e:Entity)
       WHERE toLower(e.name) CONTAINS toLower($q)
       RETURN e.id AS id, e.name AS name, e.type AS type
       LIMIT toInteger($limit)`,
      { q, limit },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      kind: 'entity',
      label: r.get('name') as string,
      snippet: r.get('type') as string,
      // Entity search has no relevance score; assign a flat 1.0 so it isn't
      // pushed below fulltext-scored hits with sub-1 relevance.
      score: 1,
    }));
  },

  // --- Graph neighborhood (depth=1) -------------------------------------
  //
  // The service composes depth=2 by calling this once with the root id and
  // then once per first-hop neighbor, deduping in TS.

  async oneHop(
    tx: ManagedTransaction,
    nodeId: string,
    edgeLimit: number,
  ): Promise<{ root: GraphNodeRow | null; nodes: GraphNodeRow[]; edges: GraphEdgeRow[] }> {
    const result = await tx.run(
      `MATCH (root {id: $id})
       OPTIONAL MATCH (root)-[r]-(neighbor)
       WITH root, r, neighbor
       LIMIT toInteger($edgeLimit)
       RETURN root {.*, _labels: labels(root)} AS root,
              collect(CASE WHEN neighbor IS NULL THEN NULL ELSE neighbor {.*, _labels: labels(neighbor)} END) AS neighbors,
              collect(CASE WHEN r IS NULL THEN NULL ELSE {
                source: startNode(r).id,
                target: endNode(r).id,
                type: type(r)
              } END) AS rels`,
      { id: nodeId, edgeLimit },
    );
    const row = result.records[0];
    if (!row) return { root: null, nodes: [], edges: [] };
    const rootRaw = row.get('root') as (Record<string, unknown> & { _labels: string[] }) | null;
    const neighbors = (row.get('neighbors') as (Record<string, unknown> & { _labels: string[] })[])
      .filter((n) => n !== null)
      .map(toGraphNodeRow);
    const edges = (row.get('rels') as GraphEdgeRow[]).filter((e) => e !== null);
    return {
      root: rootRaw ? toGraphNodeRow(rootRaw) : null,
      nodes: neighbors,
      edges,
    };
  },

  // --- Graph overview (cosmos view) --------------------------------------
  //
  // Whole-graph snapshot for the cosmos visualization. Rather than an arbitrary
  // `MATCH (n) ... LIMIT`, which a high-count kind (chunks) dominates entirely,
  // node selection is BALANCED: each included kind gets its own quota, ordered
  // by a meaningful signal (importance/refCount for facts, HAS_FACT degree for
  // entities, recency otherwise). Callers exclude noisy kinds (chunks/episodes)
  // so the map shows what the memory *knows*, not the transcript it came from.
  // Only label-bearing scalar props are projected so embeddings never ride along.

  async overviewNodes(
    tx: ManagedTransaction,
    input: { maxNodes: number; scope: ScopeFilter; excludeKinds?: string[] },
  ): Promise<GraphNodeRow[]> {
    const blocks = overviewBlocks(input.scope, input.excludeKinds);
    if (blocks.units.length === 0) return [];
    const quota = Math.max(1, Math.floor(input.maxNodes / blocks.units.length));
    const cypher = blocks.units.map((u) => u(quota)).join('\nUNION\n');
    const result = await tx.run(cypher, blocks.params);
    return result.records
      .map((r) => ({
        id: (r.get('id') as string | null) ?? '',
        labels: r.get('labels') as string[],
        props: {
          kind: r.get('kind'),
          name: r.get('name'),
          content: r.get('content'),
          text: r.get('text'),
          summary: r.get('summary'),
          title: r.get('title'),
          key: r.get('key'),
          value: r.get('value'),
          id: r.get('id'),
        } as Record<string, unknown>,
      }))
      .filter((row) => row.id.length > 0);
  },

  async overviewNodeCount(
    tx: ManagedTransaction,
    scope: ScopeFilter,
    excludeKinds?: string[],
  ): Promise<number> {
    const { clause, params } = overviewWhere(scope, excludeKinds);
    const result = await tx.run(`MATCH (n) WHERE ${clause} RETURN count(n) AS count`, params);
    return (result.records[0]?.get('count') as number | undefined) ?? 0;
  },

  async overviewEdges(
    tx: ManagedTransaction,
    ids: string[],
    maxEdges: number,
  ): Promise<GraphEdgeRow[]> {
    const result = await tx.run(
      `MATCH (a)-[r]->(b)
       WHERE a.id IN $ids AND b.id IN $ids
       WITH a, r, b
       LIMIT toInteger($maxEdges)
       RETURN a.id AS source, b.id AS target, type(r) AS type`,
      { ids, maxEdges },
    );
    return result.records.map((r) => ({
      source: r.get('source') as string,
      target: r.get('target') as string,
      type: r.get('type') as string,
    }));
  },

  async supersedeChain(tx: ManagedTransaction, factId: string): Promise<Fact[]> {
    // Walk `:SUPERSEDES` edges in both directions and union the reachable facts.
    // CALL subqueries isolate the aggregations so Cypher doesn't complain about
    // implicit grouping keys. `*0..` includes the requested fact in both legs;
    // DISTINCT collapses it. Ordered by validFrom ASC so the chain reads
    // oldest → newest.
    const result = await tx.run(
      `MATCH (f:Fact {id: $id})
       CALL {
         WITH f
         OPTIONAL MATCH (f)-[:SUPERSEDES*0..]->(older:Fact)
         RETURN collect(DISTINCT older) AS olders
       }
       CALL {
         WITH f
         OPTIONAL MATCH (newer:Fact)-[:SUPERSEDES*0..]->(f)
         RETURN collect(DISTINCT newer) AS newers
       }
       WITH olders + newers AS combined
       UNWIND combined AS fact
       WITH DISTINCT fact
       WHERE fact IS NOT NULL
       OPTIONAL MATCH (e:Entity)-[:HAS_FACT]->(fact)
       WITH fact, collect(e.id) AS entityIds
       RETURN fact {.*} AS f, entityIds
       ORDER BY fact.validFrom ASC`,
      { id: factId },
    );
    return result.records.map((r) =>
      toFactRow(r.get('f') as Record<string, unknown>, r.get('entityIds') as string[]),
    );
  },

  async listDreamRuns(
    tx: ManagedTransaction,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      startedAt: Date;
      completedAt: Date | null;
      status: string;
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
    }>
  > {
    const result = await tx.run(
      `MATCH (d:DreamRun)
       RETURN d {.*} AS d
       ORDER BY d.startedAt DESC
       LIMIT toInteger($limit)`,
      { limit },
    );
    return result.records.map((r) => {
      const d = r.get('d') as Record<string, unknown>;
      return {
        id: d.id as string,
        startedAt: toJsDate(d.startedAt),
        completedAt: toJsDateOrNull(d.completedAt),
        status: d.status as string,
        episodesProcessed: (d.episodesProcessed as number) ?? 0,
        episodesFailed: (d.episodesFailed as number) ?? 0,
        factsCreated: (d.factsCreated as number) ?? 0,
        factsSuperseded: (d.factsSuperseded as number) ?? 0,
        factsPruned: (d.factsPruned as number) ?? 0,
        factsMerged: (d.factsMerged as number) ?? 0,
        insightsPromoted: (d.insightsPromoted as number) ?? 0,
        extractionFailures: (d.extractionFailures as number) ?? 0,
        supersedeFailures: (d.supersedeFailures as number) ?? 0,
        relationsCreated: (d.relationsCreated as number) ?? 0,
        synonymsCreated: (d.synonymsCreated as number) ?? 0,
        entitiesReembedded: (d.entitiesReembedded as number) ?? 0,
        error: (d.error as string | undefined) ?? undefined,
      };
    });
  },
};

// All memory kinds eligible for the cosmos, plus the synthetic 'entity' block.
// Order here is cosmetic; quotas are per-kind regardless.
const OVERVIEW_KINDS = [
  'fact',
  'insight',
  'preference',
  'procedure',
  'knowledge_document',
  'research',
  'episode',
  'observation',
  'chunk',
  'knowledge_chunk',
] as const;

// Per-kind ordering signal so a kind's quota is filled with its MOST meaningful
// nodes (highest importance / most referenced / most recent), not an arbitrary
// slice. Missing props sort last under DESC, so coalesce only guards arithmetic.
const OVERVIEW_ORDER_BY: Record<string, string> = {
  fact: 'coalesce(n.importance, 0) DESC, coalesce(n.referenceCount, 0) DESC',
  insight: 'coalesce(n.importance, 0) DESC, n.createdAt DESC',
  preference: 'coalesce(n.referenceCount, 0) DESC, n.validFrom DESC',
  procedure: 'coalesce(n.invocationCount, 0) DESC, n.updatedAt DESC',
  knowledge_document: 'n.updatedAt DESC',
  research: 'n.updatedAt DESC',
  episode: 'n.timestamp DESC',
  observation: 'n.recordedAt DESC',
  chunk: 'n.createdAt DESC',
  knowledge_chunk: 'n.createdAt DESC',
};

const OVERVIEW_RETURN = `RETURN n.id AS id, labels(n) AS labels, n.kind AS kind,
          n.name AS name, n.content AS content, n.text AS text,
          n.summary AS summary, n.title AS title, n.key AS key, n.value AS value`;

// Build one balanced UNION block per included kind (+ entities). Each block is a
// function of its quota so the caller can size them once the kind count is known.
// Scope (projectId/userId) constrains :MemoryItem kinds only — entities carry no
// scope and stay in as global connectors. `excludeKinds` drops kinds entirely
// (e.g. the default Option-A view hides chunk/knowledge_chunk/episode); pass
// 'entity' to drop the entity hubs too.
function overviewBlocks(
  scope: ScopeFilter,
  excludeKinds: string[] = [],
): { units: Array<(quota: number) => string>; params: Record<string, string> } {
  const excluded = new Set(excludeKinds);
  const scoped = buildScopeClause('n', scope);
  const scopeAnd = scoped.clause ? `AND ${scoped.clause}` : '';
  const units: Array<(quota: number) => string> = [];

  for (const kind of OVERVIEW_KINDS) {
    if (excluded.has(kind)) continue;
    const validTo = kind === 'fact' ? 'AND n.validTo IS NULL' : '';
    const orderBy = OVERVIEW_ORDER_BY[kind] ?? 'n.id';
    units.push(
      (quota: number) =>
        `MATCH (n:MemoryItem)
         WHERE n.kind = '${kind}' AND n.id IS NOT NULL ${validTo} ${scopeAnd}
         WITH n ORDER BY ${orderBy} LIMIT ${quota}
         ${OVERVIEW_RETURN}`,
    );
  }

  if (!excluded.has('entity')) {
    units.push(
      (quota: number) =>
        `MATCH (n:Entity)
         WHERE n.id IS NOT NULL
         OPTIONAL MATCH (n)-[hf:HAS_FACT]->()
         WITH n, count(hf) AS deg ORDER BY deg DESC LIMIT ${quota}
         ${OVERVIEW_RETURN}`,
    );
  }

  return { units, params: scoped.params };
}

// WHERE clause for the overview node COUNT (drives the `truncated` flag). Mirrors
// the kind set selected by overviewBlocks: entities always count unless excluded;
// scope constrains memory items; superseded facts are excluded.
function overviewWhere(
  scope: ScopeFilter,
  excludeKinds: string[] = [],
): {
  clause: string;
  params: Record<string, string>;
} {
  const excluded = new Set(excludeKinds);
  const scoped = buildScopeClause('n', scope);
  const includedKinds = OVERVIEW_KINDS.filter((k) => !excluded.has(k));
  const wantEntity = !excluded.has('entity');

  const labelParts: string[] = [];
  if (includedKinds.length > 0) {
    labelParts.push(
      `(n:MemoryItem AND n.kind IN [${includedKinds.map((k) => `'${k}'`).join(', ')}])`,
    );
  }
  if (wantEntity) labelParts.push('n:Entity');
  // Nothing included → match nothing.
  if (labelParts.length === 0) return { clause: 'false', params: {} };

  const parts = [
    `(${labelParts.join(' OR ')})`,
    'n.id IS NOT NULL',
    '(NOT n:Fact OR n.validTo IS NULL)',
  ];
  if (scoped.clause) parts.push(`(n:Entity OR (${scoped.clause}))`);
  return { clause: parts.join(' AND '), params: scoped.params };
}

function toGraphNodeRow(raw: Record<string, unknown> & { _labels: string[] }): GraphNodeRow {
  const { _labels, ...rest } = raw;
  return {
    id: (rest.id as string) ?? '',
    labels: _labels,
    props: rest,
  };
}

async function runFulltextSearch(
  tx: ManagedTransaction,
  opts: {
    q: string;
    limit: number;
    index: string;
    label: string;
    textField: string;
    kind: string;
  },
): Promise<GraphSearchHit[]> {
  // Index, label, and textField are repo-controlled identifiers (not user
  // input), so safe to interpolate. q + limit ride as parameters.
  const result = await tx.run(
    `CALL db.index.fulltext.queryNodes('${opts.index}', $q) YIELD node, score
     WHERE node:${opts.label}
     RETURN node.id AS id, node.${opts.textField} AS text, score
     LIMIT toInteger($limit)`,
    { q: opts.q, limit: opts.limit },
  );
  return result.records.map((r) => {
    const text = r.get('text') as string;
    return {
      id: r.get('id') as string,
      kind: opts.kind,
      label: truncate(text, 80),
      snippet: truncate(text, 200),
      score: r.get('score') as number,
    };
  });
}
