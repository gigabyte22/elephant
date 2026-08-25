import { z } from 'zod';
import { read } from '../../config/neo4j.ts';
import type { Container } from '../../index.ts';
import { toWireFact } from '../../models/wire.ts';
import { FactRepository } from '../../repositories/FactRepository.ts';
import { notFound } from '../errors.ts';
import { assertInScope, ScopeGuardQuery } from '../scope-guard.ts';
import type { App } from '../types.ts';
import { okEnvelope, WireFactSchema } from '../wire-schemas.ts';

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
  // Origin scope for direct writes with no source episode (adapter tool calls).
  // When sourceEpisodeId is present, episode-derived origin still wins at recall.
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  // Attribution for the audit trail; defaults to the service's ingest actor.
  actor: z.string().min(1).optional(),
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

  // Read-before-write for the mutations below, guarded the same way they are: a
  // fact id is often derived from its content and scope rather than handed out,
  // so holding one is not proof of ownership.
  app.route({
    method: 'GET',
    url: '/facts/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: ScopeGuardQuery,
      response: { 200: okEnvelope(WireFactSchema) },
    },
    handler: async (req) => {
      const fact = assertInScope(
        await read((tx) => FactRepository.get(tx, req.params.id)),
        req.query,
        `fact ${req.params.id}`,
      );
      // FactRepository.get has no deletedAt filter on purpose — ingestion needs to
      // see it to reject undelete-by-recreate — so the read gate lives here instead:
      // redaction is retroactive on every read path. Supersession is history, not
      // redaction, so a superseded fact still returns.
      if (fact.deletedAt) throw notFound(`fact ${req.params.id}`);
      return { ok: true as const, data: toWireFact(fact) };
    },
  });

  app.route({
    method: 'POST',
    url: '/facts/:id/supersede',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: ScopeGuardQuery,
      body: SupersedeBody,
      response: { 200: okEnvelope(z.object({ ok: z.literal(true) })) },
    },
    handler: async (req) => {
      // Resolving here also turns a missing old fact from the service's 400 into
      // a 404: a 400/404 split would tell a prober which ids exist in a scope it
      // cannot see. Only the old fact is guarded — it is the one being mutated.
      assertInScope(
        await read((tx) => FactRepository.get(tx, req.params.id)),
        req.query,
        `fact ${req.params.id}`,
      );
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
      querystring: ScopeGuardQuery,
      response: { 200: okEnvelope(z.object({ deleted: z.literal(true) })) },
    },
    handler: async (req) => {
      // Unfiltered get on purpose: an already-redacted fact still resolves, so a
      // repeat DELETE stays a 200 no-op rather than becoming a 404.
      assertInScope(
        await read((tx) => FactRepository.get(tx, req.params.id)),
        req.query,
        `fact ${req.params.id}`,
      );
      await container.ingestion.softDelete(req.params.id);
      return { ok: true as const, data: { deleted: true as const } };
    },
  });
}
