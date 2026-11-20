import { z } from 'zod';
import type { Container } from '../../index.ts';
import { toWireFact, toWirePreference } from '../../models/wire.ts';
import { FactListScopeQuery, factListScope } from '../scope-guard.ts';
import type { App } from '../types.ts';
import { okEnvelope, WireFactSchema, WirePreferenceSchema } from '../wire-schemas.ts';

// The scope narrows the facts, with or without entityId. The preference lookup
// ignores it and reads the unscoped row, as it always has.
const Query = FactListScopeQuery.extend({
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
      const snapshot = await container.temporal.snapshotAt({
        ...req.query,
        scope: factListScope(req.query),
      });
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
