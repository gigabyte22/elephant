// OKF vault sync: re-project all Research + KnowledgeDocument nodes into the
// markdown vault. Serves three jobs:
//   1. Initial backfill when OKF is enabled on an existing graph.
//   2. Crash repair for the gap between a graph commit and its vault write
//      (projection is log-and-continue, so the graph is the authority).
//   3. Tombstoning naturally-lapsed research — expiry is enforced on read,
//      no graph-side reaper exists, so this is where lapsed items reach
//      _trash/.
//
// Hash-gated and idempotent: live items are rewritten only when the vault
// file is missing or its frontmatter contentHash/updatedAt disagree with the
// graph. Driven by `pnpm okf:sync` (scripts/okf-sync.ts) and, when
// OKF_ENABLED, by src/jobs/OkfSyncScheduler.ts.

import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { read } from '../../config/neo4j.ts';
import { toJsDate, toJsDateOrNull } from '../../utils/neo4j-conv.ts';
import {
  type NarrativeItem,
  bodyFor,
  frontmatterFor,
  parseVaultDoc,
  pathFor,
} from './frontmatter.ts';
import { createFsVaultWriter } from './fs-vault-writer.ts';
import type { VaultKind } from './types.ts';

const BATCH = 5000;

// Exactly what the vault projects, plus the expiry the sweep gates on.
interface NarrativeRow extends NarrativeItem {
  expiresAt: Date | null;
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
      const last = rows[rows.length - 1];
      if (!last) break;
      cursor = last.id;

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

        await vault.write(frontmatterFor(kind, row), bodyFor(row));
        stats.written += 1;
      }
    }
  }

  return stats;
}
