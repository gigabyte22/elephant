import { z } from 'zod';
import type { Container } from '../../index.ts';
import { toWireObservation } from '../../models/wire.ts';
import type { App } from '../types.ts';
import { WireObservationSchema, okEnvelope } from '../wire-schemas.ts';

export function registerObservationsRoutes(app: App, container: Container): void {
  app.route({
    method: 'POST',
    url: '/observations',
    schema: {
      body: z.object({
        id: z.string().uuid().optional(),
        agentId: z.string().min(1),
        sessionId: z.string().min(1),
        content: z.string().min(1),
      }),
      response: { 200: okEnvelope(WireObservationSchema) },
    },
    handler: async (req) => {
      const obs = await container.observations.write(req.body);
      return { ok: true as const, data: toWireObservation(obs) };
    },
  });

  app.route({
    method: 'GET',
    url: '/observations',
    schema: {
      querystring: z.object({
        sessionId: z.string().min(1),
        limit: z.coerce.number().int().positive().max(500).optional(),
      }),
      response: {
        200: okEnvelope(z.object({ observations: z.array(WireObservationSchema) })),
      },
    },
    handler: async (req) => {
      const obs = await container.observations.listForSession(req.query.sessionId, req.query.limit);
      return {
        ok: true as const,
        data: { observations: obs.map(toWireObservation) },
      };
    },
  });
}
