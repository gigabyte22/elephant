// Re-embed the whole graph with the embedder configured in .env. This is how
// to change MEMORY_EMBED_PROVIDER, the embedding model, or EMBED_DIM once a
// graph has data: boot refuses to start until the stored vectors match the
// configured embedder.
//
//   1. stop the service (recall is wrong while vectors are mixed, and a
//      dimension change drops the vector indexes until the run finishes)
//   2. edit .env: the new provider/model and its EMBED_DIM
//   3. pnpm reembed --dry-run     # what would change, and a live probe of the model
//   4. pnpm reembed --yes
//   5. start the service
//
// An interrupted run leaves the stored model unchanged, so boot keeps refusing;
// run it again from the start. Back up the graph first (scripts/backup-neo4j.py).

import { buildEmbeddingAdapter, embedModelId } from '../src/adapters/factory.ts';
import { loadEnv } from '../src/config/env.ts';
import { closeDriver, verifyConnectivity } from '../src/config/neo4j.ts';
import { reembed } from '../src/reembed.ts';

const dryRun = process.argv.includes('--dry-run');
const confirmed = process.argv.includes('--yes');
const batchArg = process.argv.find((a) => a.startsWith('--batch='));

async function main(): Promise<void> {
  if (!dryRun && !confirmed) {
    console.error('[reembed] pass --dry-run to preview, or --yes to re-embed the graph.');
    process.exit(2);
  }
  const env = loadEnv();
  await verifyConnectivity();
  const embedder = buildEmbeddingAdapter(env);
  if (embedder.dim !== env.EMBED_DIM) {
    throw new Error(
      `embedding adapter dim (${embedder.dim}) does not match EMBED_DIM (${env.EMBED_DIM})`,
    );
  }

  const report = await reembed({
    embedder,
    embedModel: embedModelId(env),
    maxInputTokens: env.EMBED_MAX_INPUT_TOKENS,
    batchSize: batchArg ? Number(batchArg.slice('--batch='.length)) : undefined,
    dryRun,
    log: (msg) => console.log(msg),
  });

  const from = report.from
    ? `${report.from.embedModel} (dim ${report.from.embedDim})`
    : 'unrecorded';
  const total = Object.values(report.counts).reduce((a, b) => a + (b ?? 0), 0);
  console.log(`[reembed] ${from} -> ${report.to.embedModel} (dim ${report.to.embedDim})`);
  for (const [label, n] of Object.entries(report.counts)) if (n) console.log(`  ${label}: ${n}`);
  console.log(
    dryRun
      ? `[reembed] dry run: ${total} vector(s) would be re-embedded` +
          (report.recreateIndexes ? ' and the vector indexes recreated' : '')
      : `[reembed] done: ${total} vector(s) re-embedded, ${report.cleared} with no source text removed`,
  );
}

main()
  .catch((err) => {
    console.error('[reembed] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
