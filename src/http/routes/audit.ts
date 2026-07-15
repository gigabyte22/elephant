import { z } from 'zod';
import { read } from '../../config/neo4j.ts';
import type { Container } from '../../index.ts';
import { toWireArchivedRevision, toWireAuditEvent } from '../../models/wire.ts';
import { AuditService } from '../../services/AuditService.ts';
import type { App } from '../types.ts';
import { WireArchivedRevisionSchema, WireAuditEventSchema, okEnvelope } from '../wire-schemas.ts';

export function registerAuditRoutes(app: App, _container: Container): void {
  app.route({
    method: 'GET',
    url: '/audit/:targetId',
    schema: {
      params: z.object({ targetId: z.string().uuid() }),
      querystring: z.object({
        limit: z.coerce.number().int().positive().max(500).optional(),
      }),
      response: {
        200: okEnvelope(
          z.object({
            revisions: z.array(WireArchivedRevisionSchema),
            events: z.array(WireAuditEventSchema),
          }),
        ),
      },
    },
    handler: async (req) => {
      const { targetId } = req.params;
      const { limit } = req.query;
      const { revisions, events } = await read(async (tx) => ({
        revisions: await AuditService.revisionsFor(tx, targetId, limit),
        events: await AuditService.eventsFor(tx, targetId, limit),
      }));
      return {
        ok: true as const,
        data: {
          revisions: revisions.map(toWireArchivedRevision),
          events: events.map(toWireAuditEvent),
        },
      };
    },
  });

  app.route({
    method: 'GET',
    url: '/audit',
    schema: {
      querystring: z.object({
        actor: z.string().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      }),
      response: { 200: okEnvelope(z.array(WireAuditEventSchema)) },
    },
    handler: async (req) => {
      const events = await read((tx) =>
        AuditService.listEvents(tx, {
          actor: req.query.actor,
          from: req.query.from,
          to: req.query.to,
          limit: req.query.limit,
        }),
      );
      return { ok: true as const, data: events.map(toWireAuditEvent) };
    },
  });
}
