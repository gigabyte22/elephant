import { z } from 'zod';
import type { Container } from '../../index.ts';
import { toWirePreference } from '../../models/wire.ts';
import { notFound } from '../errors.ts';
import type { App } from '../types.ts';
import { okEnvelope, WirePreferenceSchema } from '../wire-schemas.ts';

// A preference is identified by (key, projectId, userId). Omitting both axes
// addresses the unscoped preference — its own row, not a wildcard over every
// project's value for that key.
const ScopeQuery = z.object({
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
});

export function registerPreferencesRoutes(app: App, container: Container): void {
  app.route({
    method: 'GET',
    url: '/preferences',
    schema: {
      querystring: ScopeQuery,
      response: {
        200: okEnvelope(z.object({ preferences: z.array(WirePreferenceSchema) })),
      },
    },
    handler: async (req) => {
      const prefs = await container.preferences.listActive(req.query);
      return { ok: true as const, data: { preferences: prefs.map(toWirePreference) } };
    },
  });

  app.route({
    method: 'GET',
    url: '/preferences/:key',
    schema: {
      params: z.object({ key: z.string().min(1) }),
      querystring: ScopeQuery,
      response: { 200: okEnvelope(WirePreferenceSchema) },
    },
    handler: async (req) => {
      const pref = await container.preferences.get(req.params.key, req.query);
      if (!pref) throw notFound(`preference ${req.params.key}`);
      return { ok: true as const, data: toWirePreference(pref) };
    },
  });

  app.route({
    method: 'PUT',
    url: '/preferences/:key',
    schema: {
      params: z.object({ key: z.string().min(1) }),
      body: z.object({
        value: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        // Attribution for the audit trail; defaults to the preference service actor.
        actor: z.string().min(1).optional(),
        projectId: z.string().min(1).optional(),
        userId: z.string().min(1).optional(),
      }),
      response: { 200: okEnvelope(WirePreferenceSchema) },
    },
    handler: async (req) => {
      const pref = await container.preferences.set({
        key: req.params.key,
        value: req.body.value,
        confidence: req.body.confidence,
        actor: req.body.actor,
        projectId: req.body.projectId,
        userId: req.body.userId,
      });
      return { ok: true as const, data: toWirePreference(pref) };
    },
  });
}
