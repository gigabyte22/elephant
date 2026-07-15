import { z } from 'zod';
import { read } from '../../config/neo4j.ts';
import type { Container } from '../../index.ts';
import { toWireFact } from '../../models/wire.ts';
import { FactRepository } from '../../repositories/FactRepository.ts';
import { notFound } from '../errors.ts';
import type { App } from '../types.ts';
import { WireFactSchema, okEnvelope } from '../wire-schemas.ts';

const FactBody = z.object({
  id: z.string().uuid().optional(),
  content: z.string().min(1),
  category: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  validFrom: z.coerce.date().optional(),
  entityNames: z.array(z.string().min(1)).optional(),
  sourceEpisodeId: z.string().uuid().optional(),
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
});

const SupersedeBody = z.object({
  newFactId: z.string().uuid(),
  reason: z.string().min(1),
});

export function registerFactsRoutes(app: App, container: Container): void {
  app.route({
    method: 'POST',
    url: '/facts',
    schema: {
      body: FactBody,
      response: { 200: okEnvelope(WireFactSchema) },
    },
    handler: async (req) => {
      const fact = await container.ingestion.saveFact(req.body);
      return { ok: true as const, data: toWireFact(fact) };
    },
  });

  app.route({
    method: 'POST',
    url: '/facts/batch',
    schema: {
      // Array cap prevents a single request from holding the embedder / Neo4j
      // connection for minutes. Callers with bigger batches should page.
      body: z.object({ facts: z.array(FactBody).min(1).max(500) }),
      response: { 200: okEnvelope(z.array(WireFactSchema)) },
    },
    handler: async (req) => {
      const facts = await container.ingestion.saveFacts(req.body.facts);
      return { ok: true as const, data: facts.map(toWireFact) };
    },
  });

  app.route({
    method: 'POST',
    url: '/facts/:id/supersede',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: SupersedeBody,
      response: { 200: okEnvelope(z.object({ ok: z.literal(true) })) },
    },
    handler: async (req) => {
      await container.ingestion.supersede({
        oldId: req.params.id,
        newId: req.body.newFactId,
        reason: req.body.reason,
      });
      return { ok: true as const, data: { ok: true as const } };
    },
  });

  app.route({
    method: 'DELETE',
    url: '/facts/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      response: { 200: okEnvelope(z.object({ deleted: z.literal(true) })) },
    },
    handler: async (req) => {
      const existing = await read((tx) => FactRepository.get(tx, req.params.id));
      if (!existing) throw notFound(`fact ${req.params.id}`);
      await container.ingestion.softDelete(req.params.id);
      return { ok: true as const, data: { deleted: true as const } };
    },
  });
}
