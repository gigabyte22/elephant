import { z } from 'zod';
import type { Container } from '../../index.ts';
import type { WorkingStateScope } from '../../models/types.ts';
import { toWireWorkingStateEntry } from '../../models/wire.ts';
import { notFound } from '../errors.ts';
import type { App } from '../types.ts';
import { WireWorkingStateEntrySchema, okEnvelope } from '../wire-schemas.ts';

const ScopeBody = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

const SetBody = z.object({
  scope: ScopeBody,
  key: z.string().min(1),
  value: z.unknown(),
  ttlSec: z.number().int().positive().optional(),
});

const KeyParams = z.object({ key: z.string().min(1) });

const ScopeQuery = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  projectId: z.string().optional(),
  prefix: z.string().optional(),
});

type ScopeQueryShape = z.infer<typeof ScopeQuery>;

function scopeFromQuery(q: ScopeQueryShape): WorkingStateScope {
  return {
    agentId: q.agentId,
    sessionId: q.sessionId,
    userId: q.userId,
    projectId: q.projectId,
  };
}

export function registerStateRoutes(app: App, container: Container): void {
  app.route({
    method: 'POST',
    url: '/state',
    schema: {
      body: SetBody,
      response: { 200: okEnvelope(z.object({ ok: z.literal(true) })) },
    },
    handler: async (req) => {
      await container.workingState.set(
        req.body.scope,
        req.body.key,
        req.body.value,
        req.body.ttlSec,
      );
      return { ok: true as const, data: { ok: true as const } };
    },
  });

  app.route({
    method: 'GET',
    url: '/state/:key',
    schema: {
      params: KeyParams,
      querystring: ScopeQuery,
      response: { 200: okEnvelope(WireWorkingStateEntrySchema) },
    },
    handler: async (req) => {
      const entry = await container.workingState.get(scopeFromQuery(req.query), req.params.key);
      if (!entry) throw notFound(`state key ${req.params.key}`);
      return { ok: true as const, data: toWireWorkingStateEntry(entry) };
    },
  });

  app.route({
    method: 'DELETE',
    url: '/state/:key',
    schema: {
      params: KeyParams,
      querystring: ScopeQuery,
      response: { 200: okEnvelope(z.object({ deleted: z.literal(true) })) },
    },
    handler: async (req) => {
      await container.workingState.delete(scopeFromQuery(req.query), req.params.key);
      return { ok: true as const, data: { deleted: true as const } };
    },
  });

  app.route({
    method: 'GET',
    url: '/state',
    schema: {
      querystring: ScopeQuery,
      response: { 200: okEnvelope(z.array(WireWorkingStateEntrySchema)) },
    },
    handler: async (req) => {
      const list = await container.workingState.list(scopeFromQuery(req.query), req.query.prefix);
      return { ok: true as const, data: list.map(toWireWorkingStateEntry) };
    },
  });
}
