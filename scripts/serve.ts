import { buildHttpServer } from '../src/http/server.ts';
import { bootstrap, shutdown } from '../src/index.ts';
import { startDreamScheduler } from '../src/jobs/DreamScheduler.ts';
import { startObservationReaper } from '../src/jobs/ObservationReaper.ts';
import { startOkfSyncScheduler } from '../src/jobs/OkfSyncScheduler.ts';

async function main(): Promise<void> {
  const container = await bootstrap();
  const app = await buildHttpServer(container);

  const dream = startDreamScheduler(container);
  const reaper = startObservationReaper(container);
  // Mirrors buildVaultWriter's gate — no vault, nothing to sweep.
  const okfSync = container.env.OKF_ENABLED ? startOkfSyncScheduler(container) : undefined;

  await app.listen({
    port: container.env.MEMORY_PORT,
    host: container.env.MEMORY_BIND,
  });

  app.log.info(
    `elephant listening on http://${container.env.MEMORY_BIND}:${container.env.MEMORY_PORT} ` +
      `(llm=${container.llm.name}, embedder=${container.embedder.name}, dim=${container.embedder.dim}, ` +
      `dreamCron=${dream.pattern}${okfSync ? `, okfSyncCron=${okfSync.pattern}` : ''})`,
  );

  const stop = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    dream.stop();
    reaper.stop();
    okfSync?.stop();
    await app.close();
    await shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('[serve] fatal:', err);
  await shutdown().catch(() => undefined);
  process.exit(1);
});
