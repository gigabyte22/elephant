import { z } from 'zod';
import type { Container } from '../../index.ts';
import { ScopeModeSchema } from '../../models/types.ts';
import { toWireResearch } from '../../models/wire.ts';
import { assertInScope, ScopeGuardQuery } from '../scope-guard.ts';
import type { App } from '../types.ts';
import { okEnvelope, WireResearchSchema } from '../wire-schemas.ts';

const CreateBody = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  source: z.string().min(1),
  sourceUri: z.string().url().optional(),
  content: z.string().min(1),
  summary: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  // Caller-supplied provenance. Stored as an opaque JSON blob and never
  // indexed, embedded, searched or scored — it exists so a caller can trace a
  // research item back to its source. Write-once: UpdateBody has no metadata.
  metadata: z.record(z.string(), z.string()).optional(),
  projectId: z.string().min(1),
  userId: z.string().min(1).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  actor: z.string().optional(),
});

const UpdateBody = z
  .object({
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    summary: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    sourceUri: z.string().url().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    actor: z.string().optional(),
    reason: z.string().optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== 'actor' && k !== 'reason'), {
    message: 'at least one field to update is required',
  });

const SimilarQuery = ScopeGuardQuery.extend({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  minScore: z.coerce.number().min(0).max(1).default(0.85),
});

const ListQuery = z
  .object({
    // Optional ONLY so an explicit projectScope can be sent instead; the
    // refinement below keeps it mandatory in every other case. Omitting both
    // selects 'none', which spans every project — the exact shape this
    // parameter set exists to prevent.
    projectId: z.string().min(1).optional(),
    userId: z.string().optional(),
    projectScope: ScopeModeSchema.optional(),
    userScope: ScopeModeSchema.optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .refine((q) => Boolean(q.projectId || q.projectScope), {
    path: ['projectId'],
    message:
      'projectId is required unless an explicit projectScope is supplied ' +
      '(projectScope=none spans every project; use it only deliberately)',
  });

export function registerResearchRoutes(app: App, container: Container): void {
  app.route({
    method: 'POST',
    url: '/research',
    schema: {
      body: CreateBody,
      response: { 200: okEnvelope(WireResearchSchema) },
    },
    handler: async (req) => {
      const research = await container.research.create(req.body);
      return { ok: true as const, data: toWireResearch(research) };
    },
  });

  app.route({
    method: 'GET',
    url: '/research/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: ScopeGuardQuery,
      response: { 200: okEnvelope(WireResearchSchema) },
    },
    handler: async (req) => {
      const research = assertInScope(
        await container.research.get(req.params.id),
        req.query,
        `research ${req.params.id}`,
      );
      return { ok: true as const, data: toWireResearch(research) };
    },
  });

  app.route({
    method: 'GET',
    url: '/research/:id/similar',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: SimilarQuery,
      response: {
        200: okEnvelope(z.array(WireResearchSchema.extend({ score: z.number() }))),
      },
    },
    handler: async (req) => {
      const { limit, minScore, ...guard } = req.query;
      const research = assertInScope(
        await container.research.get(req.params.id),
        guard,
        `research ${req.params.id}`,
      );
      const similar = await container.research.similar(research, {
        limit,
        minScore,
        userId: guard.userId,
      });
      return {
        ok: true as const,
        data: similar.map((r) => ({ ...toWireResearch(r), score: r.score })),
      };
    },
  });

  app.route({
    method: 'PUT',
    url: '/research/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: ScopeGuardQuery,
      body: UpdateBody,
      response: { 200: okEnvelope(WireResearchSchema) },
    },
    handler: async (req) => {
      assertInScope(
        await container.research.get(req.params.id),
        req.query,
        `research ${req.params.id}`,
      );
      const updated = await container.research.update(req.params.id, req.body);
      return { ok: true as const, data: toWireResearch(updated) };
    },
  });

  app.route({
    method: 'GET',
    url: '/research',
    schema: {
      querystring: ListQuery,
      response: { 200: okEnvelope(z.array(WireResearchSchema)) },
    },
    handler: async (req) => {
      const list = await container.research.list({
        scope: {
          projectId: req.query.projectId,
          userId: req.query.userId,
          // Explicit mode wins, else inferred from the id. Unlike the sibling
          // routes the 'none' arm here is unreachable — it needs neither projectId
          // nor projectScope, which the schema refuses — so spanning every project
          // is only ever an explicit projectScope=none. The arm stays so this
          // reads identically to the knowledge and procedures list routes.
          projectScope: req.query.projectScope ?? (req.query.projectId ? 'filter' : 'none'),
          userScope: req.query.userScope ?? (req.query.userId ? 'filter' : 'none'),
        },
        limit: req.query.limit,
      });
      return { ok: true as const, data: list.map(toWireResearch) };
    },
  });

  app.route({
    method: 'DELETE',
    url: '/research/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      // DELETE was the one research route without a scope guard, so a caller
      // scoped to project A could delete project B's record by id.
      querystring: ScopeGuardQuery,
      response: { 200: okEnvelope(z.object({ deleted: z.literal(true) })) },
    },
    handler: async (req) => {
      assertInScope(
        await container.research.get(req.params.id),
        req.query,
        `research ${req.params.id}`,
      );
      await container.research.softDelete(req.params.id);
      return { ok: true as const, data: { deleted: true as const } };
    },
  });
}
