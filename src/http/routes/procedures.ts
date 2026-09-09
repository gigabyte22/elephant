import { z } from 'zod';
import type { Container } from '../../index.ts';
import { ScopeModeSchema } from '../../models/types.ts';
import { toWireProcedure } from '../../models/wire.ts';
import { axisAllows } from '../../services/retrieval/stages/PostFilterStage.ts';
import { assertInScope, ScopeGuardQuery } from '../scope-guard.ts';
import type { App } from '../types.ts';
import { okEnvelope, WireProcedureSchema } from '../wire-schemas.ts';

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
  // Explicit modes, for the question an id alone cannot ask: `shared` lists
  // the null-scoped procedures only. The defaults below are inferred from
  // whether an id was supplied, which is the historical behaviour.
  projectScope: ScopeModeSchema.optional(),
  userScope: ScopeModeSchema.optional(),
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
      querystring: ScopeGuardQuery,
      response: { 200: okEnvelope(WireProcedureSchema) },
    },
    handler: async (req) => {
      const proc = assertInScope(
        await container.procedures.get(req.params.id),
        req.query,
        `procedure ${req.params.id}`,
      );
      return { ok: true as const, data: toWireProcedure(proc) };
    },
  });

  app.route({
    method: 'PUT',
    url: '/procedures/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: ScopeGuardQuery,
      body: UpdateBody,
      response: { 200: okEnvelope(WireProcedureSchema) },
    },
    handler: async (req) => {
      assertInScope(
        await container.procedures.get(req.params.id),
        req.query,
        `procedure ${req.params.id}`,
      );
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
        // getByName matches on `coalesce(p.projectId,'') = coalesce($projectId,'')`
        // — exact, so it can never return another project's row, and omitting the
        // id already means "the shared one". projectScope=shared is that request.
        const projectId = req.query.projectScope === 'shared' ? undefined : req.query.projectId;
        const proc = await container.procedures.getByName(req.query.name, projectId);
        // …but the lookup ignores userId entirely, so apply the declared user scope
        // here rather than returning another user's procedure. axisAllows is the
        // same rule the list path pushes into Cypher, reused so the two branches
        // of this one route cannot drift apart. A miss and an out-of-scope hit
        // both answer with an empty list rather than a 404: this route returns a
        // list, and a 404 would make the status an existence oracle.
        const userMode = req.query.userScope ?? (req.query.userId ? 'filter' : 'none');
        if (!proc || !axisAllows(proc.userId, req.query.userId, userMode)) {
          return { ok: true as const, data: [] };
        }
        return { ok: true as const, data: [toWireProcedure(proc)] };
      }
      const list = await container.procedures.list({
        scope: {
          projectId: req.query.projectId,
          userId: req.query.userId,
          // Explicit modes win; absent them the mode is inferred from whether an id
          // was supplied, so no existing caller moves. Neither supplied ⇒ 'none',
          // which spans every project — the historical behaviour of this route.
          projectScope: req.query.projectScope ?? (req.query.projectId ? 'filter' : 'none'),
          userScope: req.query.userScope ?? (req.query.userId ? 'filter' : 'none'),
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
      querystring: ScopeGuardQuery,
      response: { 200: okEnvelope(z.object({ deleted: z.literal(true) })) },
    },
    handler: async (req) => {
      assertInScope(
        await container.procedures.get(req.params.id),
        req.query,
        `procedure ${req.params.id}`,
      );
      await container.procedures.softDelete(req.params.id);
      return { ok: true as const, data: { deleted: true as const } };
    },
  });
}
