import { z } from 'zod';
import type { Container } from '../../index.ts';
import { toWireFact, toWirePreference } from '../../models/wire.ts';
import type { App } from '../types.ts';
import { WireFactSchema, WirePreferenceSchema, okEnvelope } from '../wire-schemas.ts';

const Query = z.object({
  at: z.coerce.date(),
  entityId: z.string().uuid().optional(),
  preferenceKey: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const ResponseShape = okEnvelope(
  z.object({
    at: z.string(),
    facts: z.array(WireFactSchema),
    preference: WirePreferenceSchema.nullable().optional(),
  }),
);

export function registerTimelineRoute(app: App, container: Container): void {
  app.route({
    method: 'GET',
    url: '/timeline',
    schema: {
      querystring: Query,
      response: { 200: ResponseShape },
    },
    handler: async (req) => {
      const snapshot = await container.temporal.snapshotAt(req.query);
      // snapshot.preference is undefined when no preferenceKey was queried,
      // null when queried but no value existed at that time. Both shapes pass through.
      let preference: ReturnType<typeof toWirePreference> | null | undefined;
      if (snapshot.preference === undefined) {
        preference = undefined;
      } else if (snapshot.preference === null) {
        preference = null;
      } else {
        preference = toWirePreference(snapshot.preference);
      }
      return {
        ok: true as const,
        data: {
          at: req.query.at.toISOString(),
          facts: snapshot.facts.map(toWireFact),
          preference,
        },
      };
    },
  });
}
