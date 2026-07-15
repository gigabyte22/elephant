import { closeDriver } from '../src/config/neo4j.ts';
import { migrate } from '../src/migrate.ts';

migrate({ log: (msg) => console.log(msg) })
  .then(() => closeDriver())
  .then(() => {
    console.log('[migrate] done');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[migrate] failed:', err);
    await closeDriver().catch(() => undefined);
    process.exit(1);
  });
