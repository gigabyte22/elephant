import { buildHttpServer } from '../src/http/server.ts';
import { bootstrap, shutdown } from '../src/index.ts';
import { startAttachmentExtractionWorker } from '../src/jobs/AttachmentExtractionWorker.ts';
import { startDreamScheduler } from '../src/jobs/DreamScheduler.ts';
import { startObservationReaper } from '../src/jobs/ObservationReaper.ts';
import { startOkfSyncScheduler } from '../src/jobs/OkfSyncScheduler.ts';
import { startResearchReaper } from '../src/jobs/ResearchReaper.ts';

async function main(): Promise<void> {
  const container = await bootstrap();
  const app = await buildHttpServer(container);

  const dream = startDreamScheduler(container);
  const reaper = startObservationReaper(container);
  const extraction = startAttachmentExtractionWorker(container);
  // Mirrors buildVaultWriter's gate — no vault, nothing to sweep.
  const okfSync = container.env.OKF_ENABLED ? startOkfSyncScheduler(container) : undefined;
  // Opt-in only — unset means research is never purged. See env.ts for why.
  const researchGraceDays = container.env.RESEARCH_RETENTION_DAYS;
  const researchReaper =
    researchGraceDays === undefined ? undefined : startResearchReaper(container, researchGraceDays);

  await app.listen({
    port: container.env.MEMORY_PORT,
    host: container.env.MEMORY_BIND,
  });

  app.log.info(
    `elephant listening on http://${container.env.MEMORY_BIND}:${container.env.MEMORY_PORT} ` +
      `(llm=${container.llm.name}, embedder=${container.embedder.name}, dim=${container.embedder.dim}, ` +
      `dreamCron=${dream.pattern}, extractionCron=${extraction.pattern}` +
      `${okfSync ? `, okfSyncCron=${okfSync.pattern}` : ''}` +
      `${researchReaper ? `, researchReapCron=${researchReaper.pattern} grace=${researchGraceDays}d` : ''})`,
  );

  const stop = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    dream.stop();
    reaper.stop();
    extraction.stop();
    okfSync?.stop();
    researchReaper?.stop();
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
