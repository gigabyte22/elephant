// Re-run text extraction on attachments whose text was never indexed.
//
// Image and audio attachments used to land as `extractionStatus:'unsupported'`
// whenever no vision/transcription provider was configured — the blob was stored
// and rendered, but its text never became searchable, and nothing surfaced that.
// Once a provider exists those rows stay stale forever, because extraction only
// ever ran at upload time. This script repairs them.
//
// It is also the recovery path for anything the async worker marked 'failed'
// (a provider outage, a missing blob) and for attachments left 'pending' by a
// crash — the worker will pick those up on its own, but this forces the issue.
//
// Idempotent: work is delegated to KnowledgeIngestionService.reextractAttachment,
// which deletes an attachment's existing chunks in the same transaction that
// writes the replacements. Re-running replaces, never duplicates.
//
// Concurrency is deliberately 1: the vision model and elephant's own embedding
// model share one GPU, so parallel extractions would queue at the provider while
// starving ordinary ingestion.
//
// Usage:
//   pnpm exec tsx scripts/backfill-attachment-extraction.ts            # dry run
//   pnpm exec tsx scripts/backfill-attachment-extraction.ts --yes
//   pnpm exec tsx scripts/backfill-attachment-extraction.ts --id=<attachmentId> --yes
//   pnpm exec tsx scripts/backfill-attachment-extraction.ts --mime-prefix=image/ --limit=10 --yes
//
// A local vision model can take minutes per image and the extractor's own
// ceiling is KNOWLEDGE_VISION_TIMEOUT_MS (default 120s). This runs off the
// request path, so raise it when backfilling large photos:
//   KNOWLEDGE_VISION_TIMEOUT_MS=1800000 pnpm exec tsx scripts/... --yes
//
// Ordering: run AFTER `pnpm migrate` and after a restart that picks up the
// provider configuration — the script builds its own container from the same
// .env the service uses.

import { loadEnv } from '../src/config/env.ts';
import { closeDriver, read } from '../src/config/neo4j.ts';
import { buildContainer } from '../src/index.ts';
import type { KnowledgeAttachment } from '../src/models/types.ts';

// 'empty' is excluded by default: a genuinely blank image legitimately extracts
// to nothing, and re-running it every backfill burns GPU for a guaranteed
// no-change. --include-empty opts back in after a model or prompt change.
const DEFAULT_STATUSES = ['unsupported', 'skipped', 'failed', 'pending'];

const dryRun = !process.argv.includes('--yes');
const includeEmpty = process.argv.includes('--include-empty');
const argValue = (flag: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`${flag}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const onlyId = argValue('--id');
const mimePrefix = argValue('--mime-prefix');
const limit = Number(argValue('--limit') ?? 0) || undefined;

async function findCandidates(): Promise<KnowledgeAttachment[]> {
  const statuses = includeEmpty ? [...DEFAULT_STATUSES, 'empty'] : DEFAULT_STATUSES;
  return read(async (tx) => {
    const result = await tx.run(
      `MATCH (d:KnowledgeDocument)-[:HAS_ATTACHMENT]->(a:KnowledgeAttachment)
       WHERE ($id IS NOT NULL AND a.id = $id)
          OR ($id IS NULL
              AND a.extractionStatus IN $statuses
              AND ($mimePrefix IS NULL OR a.mimeType STARTS WITH $mimePrefix))
       RETURN a {.*} AS a
       ORDER BY a.createdAt ASC`,
      { id: onlyId ?? null, statuses, mimePrefix: mimePrefix ?? null },
    );
    return result.records.map((r) => r.get('a') as KnowledgeAttachment);
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log(
    `[backfill-attachment-extraction] ${env.NEO4J_URI} (db=${env.NEO4J_DATABASE}) ` +
      `dryRun=${dryRun} visionProvider=${env.KNOWLEDGE_VISION_PROVIDER} ` +
      `visionModel=${env.KNOWLEDGE_VISION_MODEL ?? '(default)'} ` +
      `visionTimeoutMs=${env.KNOWLEDGE_VISION_TIMEOUT_MS}`,
  );

  let candidates = await findCandidates();
  const found = candidates.length;
  if (limit && candidates.length > limit) candidates = candidates.slice(0, limit);

  console.log(`  candidates: ${found}${limit && found > limit ? ` (limited to ${limit})` : ''}`);
  for (const a of candidates) {
    console.log(`    ${a.id}  ${a.extractionStatus.padEnd(11)} ${a.mimeType}  ${a.filename}`);
  }

  if (candidates.length === 0) {
    console.log('\nNothing to do.');
    return;
  }
  if (dryRun) {
    console.log('\nDry run. Re-run with --yes to apply.');
    return;
  }

  const container = await buildContainer();
  const tally: Record<string, number> = {};
  let done = 0;

  for (const a of candidates) {
    const started = Date.now();
    try {
      const updated = await container.knowledge.reextractAttachment(a.id, {
        actor: 'backfill-attachment-extraction',
      });
      tally[updated.extractionStatus] = (tally[updated.extractionStatus] ?? 0) + 1;
      console.log(
        `  … ${++done}/${candidates.length} ${a.filename}: ${a.extractionStatus} -> ` +
          `${updated.extractionStatus} (${updated.extractedChars} chars, ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s)` +
          (updated.detail ? ` — ${updated.detail}` : ''),
      );
    } catch (err) {
      tally.error = (tally.error ?? 0) + 1;
      console.error(`  … ${++done}/${candidates.length} ${a.filename}: ERROR`, err);
    }
  }

  const summary = Object.entries(tally)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`\nDone. ${summary}`);
}

main()
  .catch((err) => {
    console.error('[backfill-attachment-extraction] failed', err);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
