// OKF vault sync: reconcile the markdown vault against the graph. Serves:
//   1. Initial backfill when OKF is enabled on an existing graph.
//   2. Crash repair for the gap between a graph commit and its vault write
//      (projection is log-and-continue, so the graph is the authority).
//   3. Tombstoning naturally-lapsed research — expiry is enforced on read,
//      no graph-side reaper exists, so this is where lapsed items reach
//      _trash/.
//   4. Reaping files whose node is gone, and migrating files left at a stale
//      path by a title edit or by the pre-v2 bare-id layout.
//
// Hash-gated and idempotent: live items are rewritten only when the vault
// file is missing or its frontmatter okfVersion/contentHash/updatedAt
// disagree with the graph. Driven by `pnpm okf:sync` (scripts/okf-sync.ts)
// and, when OKF_ENABLED, by src/jobs/OkfSyncScheduler.ts.

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { read } from '../../config/neo4j.ts';
import { toJsDate, toJsDateOrNull } from '../../utils/neo4j-conv.ts';
import {
  bucketDirFor,
  matchesId,
  type NarrativeItem,
  parseVaultDoc,
  pathFor,
  vaultDocFor,
} from './frontmatter.ts';
import { createFsVaultWriter } from './fs-vault-writer.ts';
import { INDEX_FILENAME, type IndexEntry, renderVaultIndex } from './index-doc.ts';
import { CURRENT_OKF_VERSION, isVaultKind, VAULT_KINDS, type VaultKind } from './types.ts';

const BATCH = 5000;

// Neo4j label per projected kind. Keyed by VaultKind rather than listed as
// pairs so a new kind cannot be added to the type without this failing to
// compile.
const NEO4J_LABEL: Record<VaultKind, string> = {
  research: 'Research',
  knowledge_document: 'KnowledgeDocument',
};

// Exactly what the vault projects, plus the expiry the sweep gates on.
interface NarrativeRow extends NarrativeItem {
  expiresAt: Date | null;
}

export interface SyncStats {
  scanned: number;
  written: number;
  skipped: number;
  /** Lapsed rows moved to _trash (deleteReason: 'expired'). */
  tombstoned: number;
  /** Files whose node is gone (deleteReason: 'orphaned'). */
  reaped: number;
  /** Files left at a stale path by a title edit or the pre-v2 layout. */
  relocated: number;
  /** Non-OKF files found in the vault and deliberately left alone. */
  foreign: number;
  /** `_index.md` files written or removed. */
  indexes: number;
  /** True when the empty-graph guard refused to reap. */
  reapSkipped: boolean;
}

export interface SyncOptions {
  now?: Date;
  /** Skip the reap/migrate pass entirely. */
  reap?: boolean;
  /** Skip `_index.md` generation. */
  index?: boolean;
  /** Report what would change without touching a byte. */
  dryRun?: boolean;
  /** Override the empty-graph guard. */
  forceReap?: boolean;
}

// What the graph says should be on disk for an id. `relPath: null` means the
// row is lapsed, so nothing should be live for it — distinct from an id being
// absent from the map, which means the node does not exist at all.
interface Expected {
  relPath: string | null;
  kind: VaultKind;
  title: string;
  projectId?: string;
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

// Every .md file under `dir`, dir-relative. `skipPrefixed` drops any entry
// whose name starts with '_' or '.', which excludes _trash/ and the generated
// _index.md notes from the live walk in one rule — an index has no node, so a
// reap that treated it as an orphan would delete and regenerate it on every
// sweep forever.
async function walkMarkdown(dir: string, opts: { skipPrefixed: boolean }): Promise<string[]> {
  const out: string[] = [];
  async function recurse(relDir: string): Promise<void> {
    const entries = await readdir(join(dir, relDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (opts.skipPrefixed && /^[._]/.test(entry.name)) continue;
      const rel = relDir === '' ? entry.name : join(relDir, entry.name);
      if (entry.isDirectory()) await recurse(rel);
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
  }
  await recurse('');
  return out;
}

// Has this id already been tombstoned? Checked by id rather than by exact
// path so a v1 tombstone is not duplicated by a v2 one on the migration run.
async function tombstoneExistsFor(baseDir: string, relPath: string, id: string): Promise<boolean> {
  const dir = dirname(join(baseDir, '_trash', relPath));
  const names = await readdir(dir).catch(() => []);
  return names.some((name) => matchesId(name, id));
}

export async function syncVault(root: string, opts: SyncOptions = {}): Promise<SyncStats> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const baseDir = resolve(root);
  const vault = createFsVaultWriter(baseDir);
  const stats: SyncStats = {
    scanned: 0,
    written: 0,
    skipped: 0,
    tombstoned: 0,
    reaped: 0,
    relocated: 0,
    foreign: 0,
    indexes: 0,
    reapSkipped: false,
  };

  // Anything modified after the sweep began was written by a concurrent
  // request and is invisible to the graph snapshot below — reaping it would
  // destroy a brand-new document. The scheduler runs this against a live
  // service, so this gate is load-bearing, not defensive.
  const startedAt = Date.now();

  // Resident for the whole sweep: at the current scale (hundreds of nodes)
  // that is nothing, but it does undo the streaming property BATCH was
  // written for. If this ever holds millions of rows, drop `title` and
  // rebuild the indexes from a second pass instead of growing the map.
  const expected = new Map<string, Expected>();

  // ---- Phase 1: forward, graph → disk -------------------------------------
  for (const kind of VAULT_KINDS) {
    let cursor = '';
    for (;;) {
      const rows = await read(async (tx) => {
        const r = await tx.run(
          `MATCH (n:${NEO4J_LABEL[kind]}) WHERE n.id > $cursor
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
        const relPath = pathFor({ kind, id: row.id, projectId: row.projectId, title: row.title });
        const lapsed = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
        expected.set(row.id, {
          relPath: lapsed ? null : relPath,
          kind,
          title: row.title,
          projectId: row.projectId,
        });

        if (lapsed) {
          if (await tombstoneExistsFor(baseDir, relPath, row.id)) {
            stats.skipped += 1;
            continue;
          }
          if (!dryRun) {
            await vault.tombstone(
              { id: row.id, kind, projectId: row.projectId, title: row.title },
              now,
              'expired',
            );
          }
          stats.tombstoned += 1;
          continue;
        }

        // Hash-gate: rewrite only when the file is missing or disagrees. The
        // okfVersion term is what migrates a vault whose format changed while
        // its content did not.
        const current = parseVaultDoc(
          await readFile(join(baseDir, relPath), 'utf8').catch(() => ''),
        );
        const inSync =
          current !== null &&
          current.meta.okfVersion === CURRENT_OKF_VERSION &&
          current.meta.contentHash === row.contentHash &&
          current.meta.updatedAt === row.updatedAt.toISOString();
        if (inSync) {
          stats.skipped += 1;
          continue;
        }

        if (!dryRun) {
          const { meta, body } = vaultDocFor(kind, row);
          await vault.write(meta, body);
        }
        stats.written += 1;
      }
    }
  }

  // ---- Phase 2: walk, disk → graph ----------------------------------------
  const candidates: Array<{ relPath: string; id: string }> = [];
  if (opts.reap !== false) {
    for (const relPath of await walkMarkdown(baseDir, { skipPrefixed: true })) {
      const absPath = join(baseDir, relPath);
      const parsed = parseVaultDoc(await readFile(absPath, 'utf8').catch(() => ''));
      // Parse gate. This — not any ratio of orphans to files — is what makes
      // a misconfigured OKF_DIR survivable: pointed at somebody's real
      // Obsidian vault, every file fails this check and nothing is touched.
      const id = parsed?.meta.id;
      if (parsed === null || typeof id !== 'string' || !isVaultKind(parsed.meta.kind)) {
        stats.foreign += 1;
        continue;
      }
      const mtime = await stat(absPath)
        .then((s) => s.mtimeMs)
        .catch(() => Number.POSITIVE_INFINITY);
      if (mtime >= startedAt) continue; // concurrent write — not ours to judge
      candidates.push({ relPath, id });
    }
  }

  // ---- Phase 3: guard -----------------------------------------------------
  // Evaluated once for the whole sweep, never per label: a graph with zero
  // Research rows and five hundred KnowledgeDocuments must still reap.
  const guardTripped =
    candidates.length > 0 && stats.scanned === 0 && opts.forceReap !== true && opts.reap !== false;
  if (guardTripped) {
    console.error(
      `[okf-sync] REFUSING TO REAP: the graph returned 0 projectable nodes but the vault holds ` +
        `${candidates.length} OKF files. Check NEO4J_URI and OKF_DIR — this is what a vault ` +
        `pointed at the wrong database looks like. Re-run with --force-reap if it is intentional.`,
    );
    stats.reapSkipped = true;
  }

  // ---- Phase 4: reconcile -------------------------------------------------
  if (!guardTripped) {
    for (const { relPath, id } of candidates) {
      const exp = expected.get(id);
      if (exp === undefined) {
        if (!dryRun) await vault.tombstoneFile(relPath, now, 'orphaned');
        stats.reaped += 1;
        continue;
      }
      if (exp.relPath === null) {
        // Lapsed row whose live file the forward pass could not reach. Move it
        // with its body rather than removing it, so the tombstone is not an
        // empty stub.
        if (!dryRun) await vault.tombstoneFile(relPath, now, 'expired');
        stats.reaped += 1;
        continue;
      }
      if (exp.relPath !== relPath) {
        // A stale path: the pre-v2 bare-id name, or a name from a previous
        // title. The forward pass has already written the current path.
        if (!dryRun) await vault.tombstoneFile(relPath, now, 'orphaned');
        stats.relocated += 1;
      }
    }
  }

  // ---- Phase 5: indexes ---------------------------------------------------
  if (opts.index !== false) {
    // Keyed by projectId (undefined = the shared bucket); the directory is a
    // function of it, so storing both would be two names for one fact.
    const buckets = new Map<string | undefined, IndexEntry[]>();
    for (const [id, exp] of expected) {
      if (exp.relPath === null) continue;
      const entries = buckets.get(exp.projectId) ?? [];
      entries.push({ kind: exp.kind, id, title: exp.title, relPath: exp.relPath });
      buckets.set(exp.projectId, entries);
    }

    for (const [projectId, entries] of buckets) {
      const rendered = renderVaultIndex({ projectId }, entries);
      const relPath = join(bucketDirFor(projectId), INDEX_FILENAME);
      const currentText = await readFile(join(baseDir, relPath), 'utf8').catch(() => null);
      // Byte-compare before writing: the rendered note carries no timestamp,
      // so an unchanged project must produce no write at all or "idempotent"
      // stops being true.
      if (currentText === rendered) continue;
      if (!dryRun) await vault.writeRaw(relPath, rendered);
      stats.indexes += 1;
    }

    // A project whose contents were entirely reaped leaves an index full of
    // dead links. It is a generated artifact with no source content, so it is
    // removed rather than tombstoned.
    const liveDirs = new Set([...buckets.keys()].map(bucketDirFor));
    for (const stale of await staleIndexPaths(baseDir, liveDirs)) {
      if (!dryRun) await rm(join(baseDir, stale), { force: true });
      stats.indexes += 1;
    }
  }

  return stats;
}

// Hard-delete the tombstones. This is the only delete in the vault system and
// is always opt-in (`pnpm okf:sync --purge`): every other path moves files
// into _trash/ rather than removing them, so this is the single place where
// review has to have happened first.
export async function purgeTrash(root: string): Promise<number> {
  const baseDir = resolve(root);
  // A vault root of '/' or '/x' would make the recursive remove below far more
  // interesting than intended.
  if (baseDir.split('/').filter(Boolean).length < 2) {
    throw new Error(`[okf-sync] refusing to purge: vault root '${baseDir}' is too close to /`);
  }
  const trashDir = join(baseDir, '_trash');
  const removed = (await walkMarkdown(trashDir, { skipPrefixed: false })).length;
  // Remove the entries rather than the directory, so _trash/ survives as a
  // stable path for the next tombstone.
  for (const name of await readdir(trashDir).catch(() => [])) {
    await rm(join(trashDir, name), { recursive: true, force: true });
  }
  return removed;
}

// Existing `_index.md` files in buckets the graph no longer populates.
async function staleIndexPaths(baseDir: string, live: Set<string>): Promise<string[]> {
  const projects = await readdir(join(baseDir, 'projects')).catch(() => []);
  const dirs = ['shared', ...projects.map((name) => join('projects', name))];
  const stale: string[] = [];
  for (const dir of dirs) {
    if (live.has(dir)) continue;
    const names = await readdir(join(baseDir, dir)).catch((): string[] => []);
    if (names.includes(INDEX_FILENAME)) stale.push(join(dir, INDEX_FILENAME));
  }
  return stale;
}
