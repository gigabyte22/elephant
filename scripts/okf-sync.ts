// OKF vault sync: re-project all Research + KnowledgeDocument nodes into the
// markdown vault. Serves three jobs:
//   1. Initial backfill when OKF is enabled on an existing graph.
//   2. Crash repair for the gap between a graph commit and its vault write
//      (projection is log-and-continue, so the graph is the authority).
//   3. Tombstoning naturally-lapsed research — expiry is enforced on read,
//      no reaper exists, so this is where lapsed items reach _trash/.
//
// Hash-gated and idempotent: live items are rewritten only when the vault
// file is missing or its frontmatter contentHash/updatedAt disagree with the
// graph. Run: pnpm okf:sync

import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { frontmatterFor, parseVaultDoc, pathFor } from '../src/adapters/vault/frontmatter.ts';
import { createFsVaultWriter } from '../src/adapters/vault/fs-vault-writer.ts';
import type { VaultKind } from '../src/adapters/vault/types.ts';
import { loadEnv } from '../src/config/env.ts';
import { closeDriver, read } from '../src/config/neo4j.ts';
import { toJsDate, toJsDateOrNull } from '../src/utils/neo4j-conv.ts';

const BATCH = 5000;

interface NarrativeRow {
  id: string;
  title: string;
  source: string;
  sourceUri?: string;
  content?: string;
  contentHash?: string;
  summary: string;
  tags: string[];
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  projectId?: string;
  userId?: string;
}

export interface SyncStats {
  scanned: number;
  written: number;
  skipped: number;
  tombstoned: number;
}

function toRow(node: Record<string, unknown>): NarrativeRow {
  return {
    id: node.id as string,
    title: (node.title as string) ?? '(untitled)',
    source: (node.source as string) ?? 'unknown',
    sourceUri: (node.sourceUri as string | undefined) ?? undefined,
    content: (node.content as string | undefined) ?? undefined,
    contentHash: (node.contentHash as string | undefined) ?? undefined,
    summary: (node.summary as string) ?? '',
    tags: (node.tags as string[]) ?? [],
    expiresAt: toJsDateOrNull(node.expiresAt),
    createdAt: toJsDate(node.createdAt),
    updatedAt: toJsDate(node.updatedAt),
    projectId: (node.projectId as string | undefined) ?? undefined,
    userId: (node.userId as string | undefined) ?? undefined,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function syncVault(root: string, now: Date = new Date()): Promise<SyncStats> {
  const baseDir = resolve(root);
  const vault = createFsVaultWriter(baseDir);
  const stats: SyncStats = { scanned: 0, written: 0, skipped: 0, tombstoned: 0 };

  const kinds: Array<{ label: string; kind: VaultKind }> = [
    { label: 'Research', kind: 'research' },
    { label: 'KnowledgeDocument', kind: 'knowledge_document' },
  ];

  for (const { label, kind } of kinds) {
    let cursor = '';
    for (;;) {
      const rows = await read(async (tx) => {
        const r = await tx.run(
          `MATCH (n:${label}) WHERE n.id > $cursor
           RETURN n {.*} AS n ORDER BY n.id ASC LIMIT ${BATCH}`,
          { cursor },
        );
        return r.records.map((rec) => toRow(rec.get('n')));
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;

      for (const row of rows) {
        stats.scanned += 1;
        const relPath = pathFor(kind, row.id, row.projectId);
        const livePath = join(baseDir, relPath);
        const trashPath = join(baseDir, '_trash', relPath);

        const lapsed = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
        if (lapsed) {
          if (await exists(trashPath)) {
            stats.skipped += 1;
          } else {
            await vault.tombstone({ id: row.id, kind, projectId: row.projectId }, now, 'expired');
            stats.tombstoned += 1;
          }
          continue;
        }

        // Hash-gate: rewrite only when the file is missing or disagrees.
        const current = (await exists(livePath))
          ? parseVaultDoc(await readFile(livePath, 'utf8'))
          : null;
        const inSync =
          current !== null &&
          current.meta.contentHash === row.contentHash &&
          current.meta.updatedAt === row.updatedAt.toISOString();
        if (inSync) {
          stats.skipped += 1;
          continue;
        }

        const body =
          row.content ??
          `${row.summary}\n\n> body not retained (pre-OKF record; only the summary survives)`;
        await vault.write(frontmatterFor(kind, row), body);
        stats.written += 1;
      }
    }
  }

  return stats;
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.OKF_ENABLED) {
    console.warn('[okf-sync] OKF_ENABLED is false — syncing anyway into', env.OKF_DIR);
  }
  const stats = await syncVault(env.OKF_DIR);
  console.log(
    `[okf-sync] scanned=${stats.scanned} written=${stats.written} skipped=${stats.skipped} tombstoned=${stats.tombstoned} → ${resolve(env.OKF_DIR)}`,
  );
}

// Only run as a CLI when executed directly (the integration tests import syncVault).
if (process.argv[1]?.endsWith('okf-sync.ts')) {
  main()
    .catch((err) => {
      console.error('[okf-sync] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => closeDriver());
}
