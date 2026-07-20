import { z } from 'zod';
import type { Container } from '../../index.ts';
import { toWireResearch } from '../../models/wire.ts';
import { notFound } from '../errors.ts';
import type { App } from '../types.ts';
import { WireResearchSchema, okEnvelope } from '../wire-schemas.ts';

const CreateBody = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  source: z.string().min(1),
  sourceUri: z.string().url().optional(),
  content: z.string().min(1),
  summary: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
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

const ListQuery = z.object({
  projectId: z.string().min(1),
  userId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
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
      querystring: z.object({ projectId: z.string().optional() }),
      response: { 200: okEnvelope(WireResearchSchema) },
    },
    handler: async (req) => {
      const research = await container.research.get(req.params.id);
      if (!research) throw notFound(`research ${req.params.id}`);
      // Scope check: a caller asking within a project must not read another
      // project's record by id. Repository.get is scope-blind, so guard here.
      // Reported as notFound rather than forbidden — existence is itself scoped.
      if (req.query.projectId && research.projectId && research.projectId !== req.query.projectId) {
        throw notFound(`research ${req.params.id}`);
      }
      return { ok: true as const, data: toWireResearch(research) };
    },
  });

  app.route({
    method: 'PUT',
    url: '/research/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: z.object({ projectId: z.string().optional() }),
      body: UpdateBody,
      response: { 200: okEnvelope(WireResearchSchema) },
    },
    handler: async (req) => {
      const existing = await container.research.get(req.params.id);
      // Same scope semantics as GET: existence is itself scoped, so a
      // cross-project id is reported as notFound, never forbidden.
      if (
        !existing ||
        (req.query.projectId && existing.projectId && existing.projectId !== req.query.projectId)
      ) {
        throw notFound(`research ${req.params.id}`);
      }
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
          // Without an explicit mode, scopeFilterClause emits an empty predicate and
          // this returns every project's research. Mirrors knowledge.ts.
          projectScope: req.query.projectId ? 'filter' : 'none',
          userScope: req.query.userId ? 'filter' : 'none',
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
      response: { 200: okEnvelope(z.object({ deleted: z.literal(true) })) },
    },
    handler: async (req) => {
      const existing = await container.research.get(req.params.id);
      if (!existing) throw notFound(`research ${req.params.id}`);
      await container.research.softDelete(req.params.id);
      return { ok: true as const, data: { deleted: true as const } };
    },
  });
}
