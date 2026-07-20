import { z } from 'zod';
import type { Container } from '../../index.ts';
import { toWireProcedure } from '../../models/wire.ts';
import { notFound } from '../errors.ts';
import type { App } from '../types.ts';
import { WireProcedureSchema, okEnvelope } from '../wire-schemas.ts';

const ScopeBody = z.object({
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
});

const CreateBody = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  content: z.string().min(1),
  whenToUse: z.string().min(1),
  scope: ScopeBody.optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  actor: z.string().optional(),
});

const UpdateBody = z.object({
  content: z.string().min(1).optional(),
  whenToUse: z.string().min(1).optional(),
  successRate: z.number().min(0).max(1).optional(),
  invocationCount: z.number().int().nonnegative().optional(),
  lastSuccessAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  reason: z.string().optional(),
  actor: z.string().optional(),
});

const ListQuery = z.object({
  projectId: z.string().optional(),
  userId: z.string().optional(),
  name: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export function registerProceduresRoutes(app: App, container: Container): void {
  app.route({
    method: 'POST',
    url: '/procedures',
    schema: {
      body: CreateBody,
      response: { 200: okEnvelope(WireProcedureSchema) },
    },
    handler: async (req) => {
      const proc = await container.procedures.create(req.body);
      return { ok: true as const, data: toWireProcedure(proc) };
    },
  });

  app.route({
    method: 'GET',
    url: '/procedures/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      response: { 200: okEnvelope(WireProcedureSchema) },
    },
    handler: async (req) => {
      const proc = await container.procedures.get(req.params.id);
      if (!proc) throw notFound(`procedure ${req.params.id}`);
      return { ok: true as const, data: toWireProcedure(proc) };
    },
  });

  app.route({
    method: 'PUT',
    url: '/procedures/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: UpdateBody,
      response: { 200: okEnvelope(WireProcedureSchema) },
    },
    handler: async (req) => {
      const updated = await container.procedures.update(req.params.id, req.body);
      return { ok: true as const, data: toWireProcedure(updated) };
    },
  });

  app.route({
    method: 'GET',
    url: '/procedures',
    schema: {
      querystring: ListQuery,
      response: { 200: okEnvelope(z.array(WireProcedureSchema)) },
    },
    handler: async (req) => {
      if (req.query.name) {
        const proc = await container.procedures.getByName(req.query.name, req.query.projectId);
        return { ok: true as const, data: proc ? [toWireProcedure(proc)] : [] };
      }
      const list = await container.procedures.list({
        scope: {
          projectId: req.query.projectId,
          userId: req.query.userId,
          // Without an explicit mode, scopeFilterClause emits an empty predicate and
          // this returns every project's procedures. Mirrors knowledge.ts.
          projectScope: req.query.projectId ? 'filter' : 'none',
          userScope: req.query.userId ? 'filter' : 'none',
        },
        limit: req.query.limit,
      });
      return { ok: true as const, data: list.map(toWireProcedure) };
    },
  });

  app.route({
    method: 'DELETE',
    url: '/procedures/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      response: { 200: okEnvelope(z.object({ deleted: z.literal(true) })) },
    },
    handler: async (req) => {
      const existing = await container.procedures.get(req.params.id);
      if (!existing) throw notFound(`procedure ${req.params.id}`);
      await container.procedures.softDelete(req.params.id);
      return { ok: true as const, data: { deleted: true as const } };
    },
  });
}
