import { basename } from 'node:path';
import { z } from 'zod';
import {
  type NarrativeItem,
  bodyFor,
  frontmatterFor,
  pathFor,
  serializeVaultDoc,
} from '../../adapters/vault/frontmatter.ts';
import type { VaultKind } from '../../adapters/vault/types.ts';
import { read } from '../../config/neo4j.ts';
import type { Container } from '../../index.ts';
import { AuditEventKindSchema, MemoryKindSchema } from '../../models/types.ts';
import { toWireAuditEvent } from '../../models/wire.ts';
import { AuditService } from '../../services/AuditService.ts';
import { notFound } from '../errors.ts';
import type { App } from '../types.ts';
import {
  ScopeQuerySchema,
  WireDocumentSortEnum,
  WireDocumentsSchema,
  WireDreamRunListSchema,
  WireEntityTypesSchema,
  WireEpisodeOriginsSchema,
  WireFactCategoriesSchema,
  WireFactSortEnum,
  WireGraphNeighborhoodSchema,
  WireGraphOverviewSchema,
  WireGraphSearchSchema,
  WireNarrativeKindEnum,
  WireNarrativeMarkdownSchema,
  WireRetentionSchema,
  WireStatsSchema,
  WireSupersedeChainSchema,
  WireTimelineBucketEnum,
  WireTimelineSchema,
  WireTopEntitiesSchema,
  WireTopFactsSchema,
  okEnvelope,
} from '../wire-schemas-dashboard.ts';
import { WireAuditEventSchema } from '../wire-schemas.ts';

type WireNarrativeMarkdown = z.infer<typeof WireNarrativeMarkdownSchema>;

// Read-only markdown view of a narrative node, backing the dashboard's "open
// as markdown". Reuses the vault's own serializer, so the result is
// byte-identical to the .md the vault sync writes for the same node.
//
// The routes below wrap this in the standard envelope rather than serving
// text/markdown: the whole client assumes {ok,data}, and the vault — not
// HTTP — is the raw-markdown surface (docs/okf-evaluation.md).
function renderVaultMarkdown(kind: VaultKind, item: NarrativeItem): WireNarrativeMarkdown {
  return {
    markdown: serializeVaultDoc(frontmatterFor(kind, item), bodyFor(item)),
    filename: basename(pathFor(kind, item.id, item.projectId)),
  };
}

export function registerDashboardRoutes(app: App, container: Container): void {
  app.route({
    method: 'GET',
    url: '/dashboard/api/stats',
    schema: {
      querystring: ScopeQuerySchema,
      response: { 200: okEnvelope(WireStatsSchema) },
    },
    handler: async (req) => {
      const data = await container.dashboard.stats(req.query);
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/timeline',
    schema: {
      querystring: ScopeQuerySchema.extend({
        kind: MemoryKindSchema.default('fact'),
        bucket: WireTimelineBucketEnum.default('day'),
        days: z.coerce.number().int().positive().max(365).default(30),
      }),
      response: { 200: okEnvelope(WireTimelineSchema) },
    },
    handler: async (req) => {
      const { kind, bucket, days, ...scope } = req.query;
      const data = await container.dashboard.timeline({ kind, bucket, days, scope });
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/facts/top',
    schema: {
      querystring: ScopeQuerySchema.extend({
        sort: WireFactSortEnum.default('refs'),
        limit: z.coerce.number().int().positive().max(200).default(20),
        offset: z.coerce.number().int().nonnegative().default(0),
        q: z.string().max(200).optional(),
        category: z.string().max(200).optional(),
      }),
      response: { 200: okEnvelope(WireTopFactsSchema) },
    },
    handler: async (req) => {
      const { sort, limit, offset, q, category, ...scope } = req.query;
      const data = await container.dashboard.topFacts({ sort, limit, offset, q, category, scope });
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/facts/categories',
    schema: {
      querystring: ScopeQuerySchema,
      response: { 200: okEnvelope(WireFactCategoriesSchema) },
    },
    handler: async (req) => {
      const data = await container.dashboard.factCategories(req.query);
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/facts/retention',
    schema: {
      querystring: ScopeQuerySchema,
      response: { 200: okEnvelope(WireRetentionSchema) },
    },
    handler: async (req) => {
      const data = await container.dashboard.retention(req.query);
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/entities/top',
    schema: {
      querystring: ScopeQuerySchema.extend({
        limit: z.coerce.number().int().positive().max(200).default(20),
      }),
      response: { 200: okEnvelope(WireTopEntitiesSchema) },
    },
    handler: async (req) => {
      const { limit, ...scope } = req.query;
      const data = await container.dashboard.topEntities({ limit, scope });
      return { ok: true as const, data };
    },
  });

  // Entities carry no scope axes — this distribution is global by design.
  app.route({
    method: 'GET',
    url: '/dashboard/api/entities/types',
    schema: {
      response: { 200: okEnvelope(WireEntityTypesSchema) },
    },
    handler: async () => {
      const data = await container.dashboard.entityTypes();
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/episodes/origins',
    schema: {
      querystring: ScopeQuerySchema,
      response: { 200: okEnvelope(WireEpisodeOriginsSchema) },
    },
    handler: async (req) => {
      const data = await container.dashboard.episodeOrigins(req.query);
      return { ok: true as const, data };
    },
  });

  // The documents ledger — the index for the narrative kinds. Without it
  // research is only reachable by stumbling onto it in the graph.
  app.route({
    method: 'GET',
    url: '/dashboard/api/documents',
    schema: {
      querystring: ScopeQuerySchema.extend({
        kind: WireNarrativeKindEnum.optional(),
        q: z.string().max(200).optional(),
        sort: WireDocumentSortEnum.default('recent'),
        limit: z.coerce.number().int().positive().max(200).default(50),
        offset: z.coerce.number().int().nonnegative().default(0),
      }),
      response: { 200: okEnvelope(WireDocumentsSchema) },
    },
    handler: async (req) => {
      const { kind, q, sort, limit, offset, ...scope } = req.query;
      const data = await container.dashboard.documents({ kind, q, sort, limit, offset, scope });
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/graph/search',
    schema: {
      querystring: z.object({
        q: z.string().min(1).max(200),
        limit: z.coerce.number().int().positive().max(50).default(20),
      }),
      response: { 200: okEnvelope(WireGraphSearchSchema) },
    },
    handler: async (req) => {
      const data = await container.dashboard.graphSearch({
        q: req.query.q,
        limit: req.query.limit,
      });
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/graph/neighborhood',
    schema: {
      querystring: z.object({
        nodeId: z.string().min(1),
        depth: z.coerce.number().int().min(1).max(2).default(1),
        maxNodes: z.coerce.number().int().positive().max(500).default(150),
      }),
      response: { 200: okEnvelope(WireGraphNeighborhoodSchema) },
    },
    handler: async (req) => {
      const data = await container.dashboard.graphNeighborhood({
        nodeId: req.query.nodeId,
        depth: req.query.depth as 1 | 2,
        maxNodes: req.query.maxNodes,
      });
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/graph/overview',
    schema: {
      querystring: ScopeQuerySchema.extend({
        maxNodes: z.coerce.number().int().positive().max(3000).default(1200),
        // Kinds to drop from the cosmos (comma-separated or repeated). Defaults
        // to hiding raw conversation layers so the map shows knowledge, not
        // transcript; the UI re-includes them on demand. 'entity' also accepted.
        excludeKinds: z
          .preprocess(
            (v) =>
              typeof v === 'string'
                ? v
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : v,
            z.array(z.string()).optional(),
          )
          .optional(),
      }),
      response: { 200: okEnvelope(WireGraphOverviewSchema) },
    },
    handler: async (req) => {
      const { maxNodes, excludeKinds, ...scope } = req.query;
      const data = await container.dashboard.graphOverview({ maxNodes, scope, excludeKinds });
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/dreams',
    schema: {
      querystring: z.object({
        limit: z.coerce.number().int().positive().max(100).default(20),
      }),
      response: { 200: okEnvelope(WireDreamRunListSchema) },
    },
    handler: async (req) => {
      const data = await container.dashboard.dreams({ limit: req.query.limit });
      return { ok: true as const, data };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/supersede-chains',
    schema: {
      querystring: z.object({ factId: z.string().uuid() }),
      response: { 200: okEnvelope(WireSupersedeChainSchema) },
    },
    handler: async (req) => {
      const data = await container.dashboard.supersedeChain({ factId: req.query.factId });
      return { ok: true as const, data };
    },
  });

  // Thin shim over the existing AuditService so the dashboard surface stays
  // entirely under `/dashboard/api/*`. Same query shape as `GET /audit`.
  app.route({
    method: 'GET',
    url: '/dashboard/api/audit',
    schema: {
      querystring: z.object({
        actor: z.string().optional(),
        kind: AuditEventKindSchema.optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().positive().max(500).default(50),
      }),
      response: { 200: okEnvelope(z.object({ items: z.array(WireAuditEventSchema) })) },
    },
    handler: async (req) => {
      const events = await read((tx) =>
        AuditService.listEvents(tx, {
          actor: req.query.actor,
          kind: req.query.kind,
          from: req.query.from,
          to: req.query.to,
          limit: req.query.limit,
        }),
      );
      return { ok: true as const, data: { items: events.map(toWireAuditEvent) } };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/research/:id/markdown',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: z.object({ projectId: z.string().optional() }),
      response: { 200: okEnvelope(WireNarrativeMarkdownSchema) },
    },
    handler: async (req) => {
      const research = await container.research.get(req.params.id);
      // Same scope semantics as GET /research/:id — a cross-project id is
      // notFound, never forbidden, because existence is itself scoped.
      if (
        !research ||
        (req.query.projectId && research.projectId && research.projectId !== req.query.projectId)
      ) {
        throw notFound(`research ${req.params.id}`);
      }
      return { ok: true as const, data: renderVaultMarkdown('research', research) };
    },
  });

  app.route({
    method: 'GET',
    url: '/dashboard/api/knowledge/documents/:id/markdown',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      response: { 200: okEnvelope(WireNarrativeMarkdownSchema) },
    },
    handler: async (req) => {
      const result = await container.knowledge.getWithAttachments(req.params.id);
      if (!result) throw notFound(`knowledge document ${req.params.id}`);
      return {
        ok: true as const,
        data: renderVaultMarkdown('knowledge_document', result.document),
      };
    },
  });
}
