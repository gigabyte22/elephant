import { z } from 'zod';
import type { Container } from '../../index.ts';
import type { IntentionStatus } from '../../models/types.ts';
import { toWireIntention } from '../../models/wire.ts';
import type { RetrievalScope } from '../../repositories/scope.ts';
import { notFound } from '../errors.ts';
import type { App } from '../types.ts';
import { WireIntentionSchema, okEnvelope } from '../wire-schemas.ts';

const StatusEnum = z.enum(['pending', 'completed', 'cancelled', 'expired']);

const ScopeBody = z.object({
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

const CreateBody = z.object({
  id: z.string().uuid().optional(),
  content: z.string().min(1),
  dueAt: z.coerce.date().nullable().optional(),
  triggerHint: z.string().min(1).nullable().optional(),
  recurring: z.boolean().optional(),
  schedule: z.string().min(1).nullable().optional(),
  importance: z.number().min(0).max(1).optional(),
  scope: ScopeBody.optional(),
  sourceEpisodeId: z.string().uuid().optional(),
  sourceFactId: z.string().uuid().optional(),
  actor: z.string().optional(),
});

const ScopeQuery = z.object({
  projectId: z.string().optional(),
  userId: z.string().optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
});

const ListQuery = ScopeQuery.extend({
  status: StatusEnum.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const DueQuery = ListQuery.extend({
  before: z.coerce.date().optional(),
});

const ActionBody = z.object({
  actor: z.string().optional(),
  reason: z.string().optional(),
});

type ScopeQueryShape = z.infer<typeof ScopeQuery>;

// Build a hard-filter RetrievalScope: every supplied axis filters exactly.
function scopeFromQuery(q: ScopeQueryShape): RetrievalScope {
  const scope: RetrievalScope = {};
  if (q.projectId) {
    scope.projectId = q.projectId;
    scope.projectScope = 'filter';
  }
  if (q.userId) {
    scope.userId = q.userId;
    scope.userScope = 'filter';
  }
  if (q.agentId) {
    scope.agentId = q.agentId;
    scope.agentScope = 'filter';
  }
  if (q.sessionId) {
    scope.sessionId = q.sessionId;
    scope.sessionScope = 'filter';
  }
  return scope;
}

export function registerIntentionsRoutes(app: App, container: Container): void {
  app.route({
    method: 'POST',
    url: '/intentions',
    schema: {
      body: CreateBody,
      response: { 200: okEnvelope(WireIntentionSchema) },
    },
    handler: async (req) => {
      const intention = await container.intentions.create({
        id: req.body.id,
        content: req.body.content,
        dueAt: req.body.dueAt ?? null,
        triggerHint: req.body.triggerHint ?? null,
        recurring: req.body.recurring,
        schedule: req.body.schedule ?? null,
        importance: req.body.importance,
        scope: req.body.scope,
        sourceEpisodeId: req.body.sourceEpisodeId,
        sourceFactId: req.body.sourceFactId,
        actor: req.body.actor,
      });
      return { ok: true as const, data: toWireIntention(intention) };
    },
  });

  // Open commitments due before a timestamp — for boot-time reconciliation and
  // "what do I still owe?" queries. NOT a continuous poll mechanism.
  app.route({
    method: 'GET',
    url: '/intentions/due',
    schema: {
      querystring: DueQuery,
      response: { 200: okEnvelope(z.array(WireIntentionSchema)) },
    },
    handler: async (req) => {
      const list = await container.intentions.listDue({
        scope: scopeFromQuery(req.query),
        before: req.query.before,
        status: (req.query.status as IntentionStatus | undefined) ?? 'pending',
        limit: req.query.limit,
      });
      return { ok: true as const, data: list.map(toWireIntention) };
    },
  });

  app.route({
    method: 'GET',
    url: '/intentions/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      response: { 200: okEnvelope(WireIntentionSchema) },
    },
    handler: async (req) => {
      const intention = await container.intentions.get(req.params.id);
      if (!intention) throw notFound(`intention ${req.params.id}`);
      return { ok: true as const, data: toWireIntention(intention) };
    },
  });

  app.route({
    method: 'GET',
    url: '/intentions',
    schema: {
      querystring: ListQuery,
      response: { 200: okEnvelope(z.array(WireIntentionSchema)) },
    },
    handler: async (req) => {
      const list = await container.intentions.list({
        scope: scopeFromQuery(req.query),
        status: req.query.status as IntentionStatus | undefined,
        limit: req.query.limit,
      });
      return { ok: true as const, data: list.map(toWireIntention) };
    },
  });

  app.route({
    method: 'POST',
    url: '/intentions/:id/complete',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: ActionBody,
      response: { 200: okEnvelope(WireIntentionSchema) },
    },
    handler: async (req) => {
      const updated = await container.intentions.complete(req.params.id, req.body);
      return { ok: true as const, data: toWireIntention(updated) };
    },
  });

  app.route({
    method: 'POST',
    url: '/intentions/:id/cancel',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: ActionBody,
      response: { 200: okEnvelope(WireIntentionSchema) },
    },
    handler: async (req) => {
      const updated = await container.intentions.cancel(req.params.id, req.body);
      return { ok: true as const, data: toWireIntention(updated) };
    },
  });

  // Records one fire of a recurring intention (bumps fireCount, audited). The
  // orchestrator's clock calls this each time it fires a recurring reminder;
  // one-time intentions use /complete instead.
  app.route({
    method: 'POST',
    url: '/intentions/:id/fired',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: ActionBody,
      response: { 200: okEnvelope(WireIntentionSchema) },
    },
    handler: async (req) => {
      const updated = await container.intentions.markFired(req.params.id, req.body);
      return { ok: true as const, data: toWireIntention(updated) };
    },
  });
}
