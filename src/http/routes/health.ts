import { z } from 'zod';
import { read, verifyConnectivity } from '../../config/neo4j.ts';
import type { Container } from '../../index.ts';
import type { App } from '../types.ts';

export function registerHealthRoute(app: App, container: Container): void {
  app.route({
    method: 'GET',
    url: '/health',
    schema: {
      response: {
        200: z.object({
          ok: z.boolean(),
          data: z.object({
            neo4j: z.boolean(),
            llm: z.object({
              name: z.string(),
              maxContextTokens: z.number(),
            }),
            embedder: z.object({
              name: z.string(),
              dim: z.number(),
              maxInputTokens: z.number(),
            }),
            schemaVectorDim: z.number().nullable(),
            dream: z.object({
              lastRun: z.string().nullable(),
              lastRunDurationMs: z.number().nullable(),
              running: z.boolean(),
              runningJobId: z.string().nullable(),
              backlogEstimate: z.number().nullable(),
            }),
          }),
        }),
      },
    },
    handler: async () => {
      let neo4jOk = false;
      let schemaVectorDim: number | null = null;
      let backlog: number | null = null;
      try {
        await verifyConnectivity();
        neo4jOk = true;
        schemaVectorDim = await read(async (tx) => {
          const result = await tx.run(
            "SHOW VECTOR INDEX YIELD name, options WHERE name = 'fact_vectors' RETURN options",
          );
          const row = result.records[0];
          if (!row) return null;
          const options = row.get('options') as { indexConfig?: Record<string, unknown> } | null;
          const cfg = options?.indexConfig;
          const v = cfg?.['vector.dimensions'];
          return typeof v === 'number' ? v : null;
        });
        backlog = await container.dreaming.backlogEstimate().catch(() => null);
      } catch {
        neo4jOk = false;
      }

      const last = await container.dreaming.lastCompleted().catch(() => null);
      const runningJobId = container.dreaming.currentRunningJobId();
      const lastDurationMs = container.dreaming.currentLastDurationMs();

      return {
        ok: true,
        data: {
          neo4j: neo4jOk,
          llm: {
            name: container.llm.name,
            maxContextTokens: container.llm.maxContextTokens,
          },
          embedder: {
            name: container.embedder.name,
            dim: container.embedder.dim,
            maxInputTokens: container.embedder.maxInputTokens,
          },
          schemaVectorDim,
          dream: {
            lastRun: last?.completedAt ? last.completedAt.toISOString() : null,
            lastRunDurationMs: lastDurationMs,
            running: runningJobId !== null,
            runningJobId,
            backlogEstimate: backlog,
          },
        },
      };
    },
  });
}
