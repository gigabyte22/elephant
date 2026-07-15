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
      response: { 200: okEnvelope(WireResearchSchema) },
    },
    handler: async (req) => {
      const research = await container.research.get(req.params.id);
      if (!research) throw notFound(`research ${req.params.id}`);
      return { ok: true as const, data: toWireResearch(research) };
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
