import { z } from 'zod';
import type { Container } from '../../index.ts';
import { DreamInProgressError } from '../../services/DreamingService.ts';
import { conflict, notFound } from '../errors.ts';
import type { App } from '../types.ts';
import { WireDreamRunSchema, okEnvelope } from '../wire-schemas.ts';

export function registerDreamRoutes(app: App, container: Container): void {
  app.route({
    method: 'POST',
    url: '/dream',
    schema: {
      response: { 200: okEnvelope(z.object({ jobId: z.string().uuid() })) },
    },
    handler: async () => {
      try {
        const { jobId } = container.dreaming.trigger();
        return { ok: true as const, data: { jobId } };
      } catch (err) {
        if (err instanceof DreamInProgressError) {
          throw conflict(`dream already running as job ${err.runningJobId}`);
        }
        throw err;
      }
    },
  });

  app.route({
    method: 'GET',
    url: '/dream/:jobId',
    schema: {
      params: z.object({ jobId: z.string().uuid() }),
      response: { 200: okEnvelope(WireDreamRunSchema) },
    },
    handler: async (req) => {
      const run = await container.dreaming.status(req.params.jobId);
      if (!run) throw notFound(`dream run ${req.params.jobId}`);
      return {
        ok: true as const,
        data: {
          id: run.id,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt ? run.completedAt.toISOString() : null,
          status: run.status,
          episodesProcessed: run.episodesProcessed,
          factsCreated: run.factsCreated,
          factsSuperseded: run.factsSuperseded,
          factsPruned: run.factsPruned,
          factsMerged: run.factsMerged,
          insightsPromoted: run.insightsPromoted,
          error: run.error,
        },
      };
    },
  });
}
