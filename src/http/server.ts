import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  type ZodTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Container } from '../index.ts';
import { bearerAuth } from './auth.ts';
import { errorHandler } from './errors.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerDashboardRoutes } from './routes/dashboard.ts';
import { registerDreamRoutes } from './routes/dream.ts';
import { registerEntitiesRoutes } from './routes/entities.ts';
import { registerEpisodesRoute } from './routes/episodes.ts';
import { registerFactsRoutes } from './routes/facts.ts';
import { registerHealthRoute } from './routes/health.ts';
import { registerIntentionsRoutes } from './routes/intentions.ts';
import { registerKnowledgeRoutes } from './routes/knowledge.ts';
import { registerObservationsRoutes } from './routes/observations.ts';
import { registerPreferencesRoutes } from './routes/preferences.ts';
import { registerProceduresRoutes } from './routes/procedures.ts';
import { registerRecallRoute } from './routes/recall.ts';
import { registerResearchRoutes } from './routes/research.ts';
import { registerStateRoutes } from './routes/state.ts';
import { registerTimelineRoute } from './routes/timeline.ts';

export async function buildHttpServer(container: Container): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: container.env.MAX_BODY_BYTES,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  await app.register(sensible);

  app.addHook('preHandler', bearerAuth(container.env.MEMORY_SERVICE_TOKEN));

  registerHealthRoute(app, container);
  registerEpisodesRoute(app, container);
  registerFactsRoutes(app, container);
  registerRecallRoute(app, container);
  registerTimelineRoute(app, container);
  registerEntitiesRoutes(app, container);
  registerPreferencesRoutes(app, container);
  registerObservationsRoutes(app, container);
  registerDreamRoutes(app, container);
  // v1.2 — knowledge / procedural / research / working-state / audit
  registerKnowledgeRoutes(app, container);
  registerProceduresRoutes(app, container);
  registerResearchRoutes(app, container);
  registerStateRoutes(app, container);
  registerIntentionsRoutes(app, container);
  registerAuditRoutes(app, container);
  registerDashboardRoutes(app, container);
  await registerDashboardStatic(app);

  return app;
}

// Serve the built SPA at /dashboard. If the build hasn't been produced yet
// (fresh checkout, no `pnpm --filter @elephant/web build`), we register a
// stub that returns a 503 — clearer than a generic 404. Dashboard routes
// register *before* the static plugin so the SPA fallback never shadows
// them.
async function registerDashboardStatic(app: FastifyInstance): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = resolve(here, '../../web/dist');
  const indexFile = resolve(webDist, 'index.html');

  if (!existsSync(indexFile)) {
    app.get('/dashboard', async (_req, reply) => {
      void reply
        .code(503)
        .type('text/plain')
        .send(
          'dashboard build not found at web/dist/index.html — run `pnpm --filter @elephant/web build`',
        );
    });
    return;
  }

  // @fastify/static serves index.html on /dashboard/ and any nested asset
  // path under it (assets/index-XYZ.js, etc.). Wildcard MUST be true so
  // hashed bundle filenames resolve — otherwise nested paths fall through
  // to our notFound handler, which returns index.html with the wrong MIME
  // type and the SPA never loads.
  // Cache strategy: hashed assets (assets/index-<hash>.js) are content-
  // addressed — a rebuild changes the filename, so they can cache forever.
  // index.html is the only mutable entry point and MUST always revalidate,
  // otherwise a browser holds a stale shell that references a deleted bundle
  // hash and the SPA fails with a MIME error. This is the cache-invalidation
  // story for rebuilds: new asset names + an uncached shell.
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/dashboard/',
    decorateReply: false,
    wildcard: true,
    redirect: true, // `/dashboard` → `/dashboard/`
    // Disable the plugin's built-in `public, max-age=0` so our per-file
    // Cache-Control below is authoritative rather than being overridden.
    cacheControl: false,
    setHeaders: (res, pathName) => {
      if (pathName.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (pathName.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  // SPA fallback: any /dashboard/<unknown> path returns index.html so Wouter
  // handles client-side routing. Read once at startup — the shell is tiny.
  const indexHtml = await readFile(indexFile, 'utf8');
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/dashboard/api/')) {
      void reply.code(404).send({ ok: false, error: 'route not found' });
      return;
    }
    if (req.url.startsWith('/dashboard')) {
      void reply.header('Cache-Control', 'no-cache').type('text/html').send(indexHtml);
      return;
    }
    void reply.code(404).send({ ok: false, error: 'route not found' });
  });
}
