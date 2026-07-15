import { z } from 'zod';
import type { Container } from '../../index.ts';
import { toWirePreference } from '../../models/wire.ts';
import { notFound } from '../errors.ts';
import type { App } from '../types.ts';
import { WirePreferenceSchema, okEnvelope } from '../wire-schemas.ts';

export function registerPreferencesRoutes(app: App, container: Container): void {
  app.route({
    method: 'GET',
    url: '/preferences',
    schema: {
      response: {
        200: okEnvelope(z.object({ preferences: z.array(WirePreferenceSchema) })),
      },
    },
    handler: async () => {
      const prefs = await container.preferences.listActive();
      return { ok: true as const, data: { preferences: prefs.map(toWirePreference) } };
    },
  });

  app.route({
    method: 'GET',
    url: '/preferences/:key',
    schema: {
      params: z.object({ key: z.string().min(1) }),
      response: { 200: okEnvelope(WirePreferenceSchema) },
    },
    handler: async (req) => {
      const pref = await container.preferences.get(req.params.key);
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
      }),
      response: { 200: okEnvelope(WirePreferenceSchema) },
    },
    handler: async (req) => {
      const pref = await container.preferences.set({
        key: req.params.key,
        value: req.body.value,
        confidence: req.body.confidence,
      });
      return { ok: true as const, data: toWirePreference(pref) };
    },
  });
}
