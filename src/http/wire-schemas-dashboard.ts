// Wire schemas for the /dashboard/api/* introspection surface.
// Kept in a dedicated file so the existing wire-schemas.ts stays focused on
// the public memory contract (EXPECTED.md §3); the dashboard schemas describe
// internal aggregate shapes used only by the built-in viewer.

import { z } from 'zod';
import { WireFactSchema, WireMemoryKindSchema, okEnvelope } from './wire-schemas.ts';

export { okEnvelope };

// --- Stats overview --------------------------------------------------------

export const WireKindCountSchema = z.object({
  kind: WireMemoryKindSchema,
  count: z.number().int().nonnegative(),
});

export const WireStatsSchema = z.object({
  kindCounts: z.array(WireKindCountSchema),
  facts: z.object({
    active: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative(),
    softDeleted: z.number().int().nonnegative(),
  }),
  entities: z.number().int().nonnegative(),
  observations: z.object({
    active: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
  }),
  supersedeEdges: z.number().int().nonnegative(),
  lastDream: z
    .object({
      id: z.string().uuid(),
      completedAt: z.string(),
      durationMs: z.number().int().nonnegative(),
      factsCreated: z.number().int().nonnegative(),
      factsSuperseded: z.number().int().nonnegative(),
      insightsPromoted: z.number().int().nonnegative(),
    })
    .nullable(),
});

// --- Timeline --------------------------------------------------------------

export const WireTimelineBucketEnum = z.enum(['day', 'hour']);

export const WireTimelinePointSchema = z.object({
  // ISO date for 'day' buckets (YYYY-MM-DD), ISO datetime for 'hour' buckets.
  bucket: z.string(),
  count: z.number().int().nonnegative(),
});

export const WireTimelineSchema = z.object({
  bucket: WireTimelineBucketEnum,
  kind: WireMemoryKindSchema,
  since: z.string(),
  points: z.array(WireTimelinePointSchema),
});

// --- Top facts / entities --------------------------------------------------

export const WireFactSortEnum = z.enum(['refs', 'importance', 'recent']);

export const WireTopFactSchema = WireFactSchema.extend({
  // Always populated for dashboard responses (refCount on WireFactSchema is optional
  // because /recall responses sometimes omit it).
  refCount: z.number().int().nonnegative(),
  lastReferencedAt: z.string().nullable(),
  // Ebbinghaus retention at response time — computed server-side so the
  // dashboard shares the dreamer's actual decay math.
  retention: z.number().min(0).max(1),
});

export const WireTopFactsSchema = z.object({
  sort: WireFactSortEnum,
  // Total matching active facts (post q/category/scope filters) for pagination.
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  items: z.array(WireTopFactSchema),
});

export const WireFactCategoriesSchema = z.object({
  // Distinct categories over active facts; null categories group as 'uncategorized'.
  items: z.array(
    z.object({
      category: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
});

export const WireTopEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  factCount: z.number().int().nonnegative(),
});

export const WireTopEntitiesSchema = z.object({
  items: z.array(WireTopEntitySchema),
});

export const WireEntityTypesSchema = z.object({
  // Entities carry no scope; this is a global distribution.
  items: z.array(
    z.object({
      type: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
});

// --- Episodes ----------------------------------------------------------------

export const WireEpisodeOriginsSchema = z.object({
  items: z.array(
    z.object({
      origin: z.string(), // 'user' | 'cron' | 'event' | 'system' | 'ingest'
      count: z.number().int().nonnegative(),
    }),
  ),
});

// --- Retention / decay -------------------------------------------------------
//
// Aggregate view over the Ebbinghaus forgetting curve applied to all active
// facts (src/utils/decay.ts). Computed server-side against the live prune
// policy so the dashboard can never drift from what the dreamer actually does.

export const WireRetentionPointSchema = z.object({
  retention: z.number().min(0).max(1),
  daysSinceLastReference: z.number().nonnegative(),
  importance: z.number().min(0).max(1),
  referenceCount: z.number().int().nonnegative(),
  exempt: z.boolean(),
});

export const WireAtRiskFactSchema = z.object({
  id: z.string().uuid(),
  content: z.string(), // truncated server-side
  importance: z.number().min(0).max(1),
  referenceCount: z.number().int().nonnegative(),
  lastReferencedAt: z.string().nullable(),
  daysSinceLastReference: z.number().nonnegative(),
  retention: z.number().min(0).max(1),
  prunable: z.boolean(),
});

export const WireRetentionSchema = z.object({
  generatedAt: z.string(),
  totalActive: z.number().int().nonnegative(),
  // True when totalActive exceeded the row cap and aggregates cover a subset.
  truncated: z.boolean(),
  policy: z.object({
    importanceExempt: z.number().min(0).max(1),
    minWindowDays: z.number().nonnegative(),
    retentionFloor: z.number().min(0).max(1),
  }),
  summary: z.object({
    exempt: z.number().int().nonnegative(),
    withinWindow: z.number().int().nonnegative(),
    atRisk: z.number().int().nonnegative(),
    prunable: z.number().int().nonnegative(),
  }),
  // 10 equal bins over [0,1); bin = lower bound.
  histogram: z.array(
    z.object({
      bin: z.number().min(0).max(1),
      count: z.number().int().nonnegative(),
    }),
  ),
  sample: z.array(WireRetentionPointSchema),
  atRisk: z.array(WireAtRiskFactSchema),
});

// --- Graph (search + neighborhood) -----------------------------------------

// The narrative kinds, listed for the documents ledger. `hasContent` is false
// for pre-retention rows whose body was never kept.
export const WireDocumentSortEnum = z.enum(['recent', 'created', 'title']);
export const WireNarrativeKindEnum = z.enum(['research', 'knowledge_document']);

export const WireDocumentItemSchema = z.object({
  id: z.string(),
  kind: WireNarrativeKindEnum,
  title: z.string(),
  summary: z.string(),
  source: z.string(),
  tags: z.array(z.string()),
  projectId: z.string().optional(),
  userId: z.string().optional(),
  hasContent: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().optional(),
});

export const WireDocumentsSchema = z.object({
  sort: WireDocumentSortEnum,
  total: z.number(),
  offset: z.number(),
  items: z.array(WireDocumentItemSchema),
});

export const WireGraphSearchResultSchema = z.object({
  id: z.string(),
  kind: z.string(), // 'fact' | 'entity' | 'chunk' | 'knowledge_chunk' | 'procedure' | …
  label: z.string(), // short display label
  snippet: z.string().optional(),
  score: z.number(),
});

export const WireGraphSearchSchema = z.object({
  q: z.string(),
  results: z.array(WireGraphSearchResultSchema),
});

// Sigma-friendly payload. id/source/target are stringified ids of the
// underlying nodes (Fact.id, Entity.id, …) — *not* Neo4j elementIds.
export const WireGraphNodeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  // Short, sanitized properties for the inspector drawer. Embeddings and long
  // text are stripped server-side.
  props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const WireGraphEdgeSchema = z.object({
  id: z.string(), // synthetic id `${type}:${source}->${target}` so Sigma can de-dup
  source: z.string(),
  target: z.string(),
  type: z.string(), // Neo4j relationship type
});

export const WireGraphNeighborhoodSchema = z.object({
  rootId: z.string(),
  depth: z.number().int().min(1).max(2),
  truncated: z.boolean(),
  nodes: z.array(WireGraphNodeSchema),
  edges: z.array(WireGraphEdgeSchema),
});

// Whole-graph snapshot for the cosmos view. Nodes are slim (no props) —
// the inspector pulls /graph/neighborhood for detail on demand.
export const WireGraphOverviewNodeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
});

export const WireGraphOverviewSchema = z.object({
  truncated: z.boolean(),
  totalNodes: z.number().int().nonnegative(),
  nodes: z.array(WireGraphOverviewNodeSchema),
  edges: z.array(WireGraphEdgeSchema),
});

// --- Dream runs ------------------------------------------------------------

export const WireDreamRunSummarySchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  status: z.enum(['running', 'completed', 'failed']),
  durationMs: z.number().int().nonnegative().nullable(),
  episodesProcessed: z.number().int().nonnegative(),
  episodesFailed: z.number().int().nonnegative().default(0),
  factsCreated: z.number().int().nonnegative(),
  factsSuperseded: z.number().int().nonnegative(),
  factsPruned: z.number().int().nonnegative(),
  factsMerged: z.number().int().nonnegative().default(0),
  insightsPromoted: z.number().int().nonnegative(),
  extractionFailures: z.number().int().nonnegative().default(0),
  supersedeFailures: z.number().int().nonnegative().default(0),
  relationsCreated: z.number().int().nonnegative().default(0),
  synonymsCreated: z.number().int().nonnegative().default(0),
  entitiesReembedded: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
});

export const WireDreamRunListSchema = z.object({
  items: z.array(WireDreamRunSummarySchema),
});

// --- Supersede chain -------------------------------------------------------

export const WireSupersedeChainSchema = z.object({
  factId: z.string().uuid(),
  // Oldest → newest, including the requested fact.
  chain: z.array(WireFactSchema),
});

// --- Narrative markdown view ----------------------------------------------

export const WireNarrativeMarkdownSchema = z.object({
  // The vault's own serialization of the node, frontmatter included.
  markdown: z.string(),
  // Basename the vault would give the file, used as the download name.
  filename: z.string(),
});

// --- Shared scope query schema --------------------------------------------

export const ScopeQuerySchema = z.object({
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  userId: z.string().optional(),
});
