// OKF vault integration: services materialize research + knowledge documents
// into a markdown vault after the graph transaction commits, tombstone on
// soft-delete, and never fail the request when the vault writer throws.
//
// Note for anyone adding a case here: `root` is shared across the file while
// clearDb() wipes the graph between tests, so by the time the sync tests run
// the vault holds files whose nodes are gone. That is the exact condition the
// reap exists to fix, which is why `reaped` is a separate counter from
// `tombstoned` — folding them together would make these assertions meaningless.

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { parseVaultDoc, serializeVaultDoc } from '../../src/adapters/vault/frontmatter.ts';
import { createFsVaultWriter } from '../../src/adapters/vault/fs-vault-writer.ts';
import type { VaultFrontmatter, VaultWriter } from '../../src/adapters/vault/types.ts';
import { write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const auth = { authorization: `Bearer ${TOKEN}` };
const PROJECT = 'okf-proj';

let root: string;
let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
// Toggled by the failure test: when set, every vault call throws.
let failVault = false;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'okf-vault-int-'));
  const inner = createFsVaultWriter(root);
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => {
    return (...args: A): Promise<R> => {
      if (failVault) throw new Error('simulated vault failure');
      return fn(...args);
    };
  };
  const vault: VaultWriter = {
    write: guard(inner.write),
    tombstone: guard(inner.tombstone),
    tombstoneFile: guard(inner.tombstoneFile),
    writeRaw: guard(inner.writeRaw),
  };
  container = await bootstrap({
    llm: createFakeLLMAdapter({}),
    embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
    vault,
  });
  app = await buildHttpServer(container);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await shutdown();
  await rm(root, { recursive: true, force: true });
});

async function clearDb(): Promise<void> {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
  failVault = false;
}

function researchRel(file: string): string {
  return join('projects', PROJECT, 'research', file);
}

function researchPath(slug: string, id: string): string {
  return join(root, researchRel(`${slug}--${id}.md`));
}

function trashedResearchPath(file: string): string {
  return join(root, '_trash', researchRel(file));
}

async function createResearch(title: string, content: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/research',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { title, source: 'manual', content, projectId: PROJECT },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

// Make a file look like it predates the sweep, so the reap's mtime gate — the
// thing that stops a concurrent write from being destroyed — treats it as a
// candidate instead of skipping it.
async function backdate(path: string): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await utimes(path, past, past);
}

const STAMP = '2026-07-20T13:00:00.000Z';

function researchMeta(
  id: string,
  title: string,
  overrides: Partial<VaultFrontmatter> = {},
): VaultFrontmatter {
  return {
    okfVersion: 2,
    id,
    kind: 'research',
    title,
    projectId: PROJECT,
    source: 'manual',
    tags: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

// Put a file into the vault behind the service's back, backdated so the reap
// will consider it. This is how the specs stage the states only a crash, a
// wiped database or a hand-edited vault produce.
async function seedVaultFile(rel: string, meta: VaultFrontmatter, body: string): Promise<void> {
  await container.vault!.writeRaw(rel, serializeVaultDoc(meta, body));
  await backdate(join(root, rel));
}

describe('OKF vault projection', () => {
  test('research create → vault file; update → rewritten; delete → _trash tombstone', async () => {
    await clearDb();
    const content = '# Vault findings\n\nThe body lands in markdown.';
    const id = await createResearch('Vault test', content);

    const livePath = researchPath('vault-test', id);
    const doc = parseVaultDoc(await readFile(livePath, 'utf8'))!;
    expect(doc.meta.okfVersion).toBe(2);
    expect(doc.meta.kind).toBe('research');
    expect(doc.meta.projectId).toBe(PROJECT);
    expect(doc.meta.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(doc.body).toBe(content);
    // The summary is the content verbatim below the LLM threshold, so it must
    // not also be sitting in the frontmatter.
    expect(doc.meta.summary).toBeUndefined();

    const put = await app.inject({
      method: 'PUT',
      url: `/research/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: 'revised vault body' },
    });
    expect(put.statusCode).toBe(200);
    const revised = parseVaultDoc(await readFile(livePath, 'utf8'))!;
    expect(revised.body).toBe('revised vault body');
    // Revision history exists alongside the vault rewrite.
    const audit = await app.inject({ method: 'GET', url: `/audit/${id}`, headers: auth });
    expect(audit.json().data.revisions).toHaveLength(1);

    const del = await app.inject({ method: 'DELETE', url: `/research/${id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    await expect(readFile(livePath, 'utf8')).rejects.toThrow();
    const trash = parseVaultDoc(
      await readFile(trashedResearchPath(`vault-test--${id}.md`), 'utf8'),
    )!;
    expect(trash.meta.deleteReason).toBe('soft_delete');
    expect(trash.meta.deletedAt).toBeTruthy();
    expect(trash.body).toBe('revised vault body');
  });

  // The slug is derived from a mutable title, so an edit moves the file. The
  // writer has to clean up after itself or the vault shows two files for one
  // node until the next nightly sweep.
  test('renaming a research title moves its file instead of duplicating it', async () => {
    await clearDb();
    const id = await createResearch('Original name', 'body');
    expect(await readFile(researchPath('original-name', id), 'utf8')).toContain('body');

    const put = await app.inject({
      method: 'PUT',
      url: `/research/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'Renamed entirely' },
    });
    expect(put.statusCode).toBe(200);

    const files = await readdir(join(root, 'projects', PROJECT, 'research'));
    expect(files.filter((f) => f.endsWith(`--${id}.md`))).toEqual([`renamed-entirely--${id}.md`]);
  });

  test('knowledge document without scope lands under shared/documents', async () => {
    await clearDb();
    const res = await app.inject({
      method: 'POST',
      url: '/knowledge/documents',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'Shared doc', source: 'manual', content: 'a shared knowledge note' },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.id as string;
    const doc = parseVaultDoc(
      await readFile(join(root, 'shared', 'documents', `shared-doc--${id}.md`), 'utf8'),
    )!;
    expect(doc.meta.kind).toBe('knowledge_document');
    expect(doc.body).toBe('a shared knowledge note');
  });

  test('okf-sync restores a deleted vault file and tombstones lapsed research', async () => {
    await clearDb();
    const { syncVault } = await import('../../src/adapters/vault/sync.ts');

    const keptContent = 'body that will be restored by sync';
    const keptId = await createResearch('Kept', keptContent);
    const lapsedId = await createResearch('Lapsed', 'will expire');

    // Simulate the crash gap: remove kept's vault file; lapse the other row.
    const keptPath = researchPath('kept', keptId);
    await rm(keptPath);
    await txWrite(async (tx) => {
      await tx.run(`MATCH (r:Research {id: $id}) SET r.expiresAt = datetime() - duration('PT1H')`, {
        id: lapsedId,
      });
    });

    const stats = await syncVault(root);
    expect(stats.written).toBeGreaterThanOrEqual(1);
    expect(stats.tombstoned).toBe(1);

    const restored = parseVaultDoc(await readFile(keptPath, 'utf8'))!;
    expect(restored.body).toBe(keptContent);
    const trash = parseVaultDoc(
      await readFile(trashedResearchPath(`lapsed--${lapsedId}.md`), 'utf8'),
    )!;
    expect(trash.meta.deleteReason).toBe('expired');
    expect(trash.body).toBe('will expire');

    // Idempotent: a second pass changes nothing at all.
    const again = await syncVault(root);
    expect(again.written).toBe(0);
    expect(again.reaped).toBe(0);
    expect(again.relocated).toBe(0);
    expect(again.indexes).toBe(0);
  });

  test('vault failure is log-and-continue: request succeeds, graph state is intact', async () => {
    await clearDb();
    failVault = true;
    const res = await app.inject({
      method: 'POST',
      url: '/research',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {
        title: 'No vault',
        source: 'manual',
        content: 'body without vault',
        projectId: PROJECT,
      },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.id as string;

    // Graph has the record even though the vault write threw.
    const got = await app.inject({ method: 'GET', url: `/research/${id}`, headers: auth });
    expect(got.statusCode).toBe(200);
    expect(got.json().data.content).toBe('body without vault');

    // And no vault file was produced. Asserted by scanning for the id rather
    // than by a computed filename, so a wrong slug can't make this pass
    // vacuously.
    const files = await readdir(join(root, 'projects', PROJECT, 'research')).catch(() => []);
    expect(files.some((f) => f.endsWith(`--${id}.md`))).toBe(false);
  });
});

describe('okf-sync reconcile', () => {
  test('a file whose node is gone is reaped into _trash', async () => {
    await clearDb();
    const { syncVault } = await import('../../src/adapters/vault/sync.ts');
    await createResearch('Still here', 'live body');

    // A file for a node that does not exist — what a wiped database leaves.
    const strayId = '3f2a0000-0000-4000-8000-0000000000ff';
    const strayRel = researchRel(`stray--${strayId}.md`);
    await seedVaultFile(strayRel, researchMeta(strayId, 'Stray'), 'orphaned body');

    const stats = await syncVault(root);
    expect(stats.reaped).toBeGreaterThanOrEqual(1);
    await expect(readFile(join(root, strayRel), 'utf8')).rejects.toThrow();
    const trash = parseVaultDoc(await readFile(join(root, '_trash', strayRel), 'utf8'))!;
    expect(trash.meta.deleteReason).toBe('orphaned');
    expect(trash.body).toBe('orphaned body');
  });

  // The parse gate, not any orphan-ratio threshold, is what makes a
  // misconfigured OKF_DIR survivable: pointed at a real Obsidian vault, every
  // file fails the check and nothing is touched.
  test('files that are not OKF documents are counted foreign and left alone', async () => {
    await clearDb();
    const { syncVault } = await import('../../src/adapters/vault/sync.ts');
    const plain = join(root, 'projects', PROJECT, 'research', 'someones-notes.md');
    const otherFm = join(root, 'projects', PROJECT, 'research', 'other-tool.md');
    await writeFile(plain, '# My notes\n\nnothing to do with elephant\n', 'utf8');
    await writeFile(otherFm, '---\ntitle: from another tool\n---\n\nbody\n', 'utf8');
    await backdate(plain);
    await backdate(otherFm);

    const stats = await syncVault(root);
    expect(stats.foreign).toBeGreaterThanOrEqual(2);
    expect(await readFile(plain, 'utf8')).toContain('nothing to do with elephant');
    expect(await readFile(otherFm, 'utf8')).toContain('from another tool');
  });

  // The filesystem analogue of tests/integration/guard.ts: a vault pointed at
  // the wrong database must not empty itself.
  test('an empty graph refuses to reap a populated vault', async () => {
    await clearDb();
    const { syncVault } = await import('../../src/adapters/vault/sync.ts');
    const id = await createResearch('About to be orphaned', 'body');
    const livePath = researchPath('about-to-be-orphaned', id);
    await backdate(livePath);

    // Every node disappears, exactly as it would with OKF_DIR right and
    // NEO4J_URI wrong.
    await clearDb();
    const stats = await syncVault(root);
    expect(stats.scanned).toBe(0);
    expect(stats.reapSkipped).toBe(true);
    expect(stats.reaped).toBe(0);
    expect(await readFile(livePath, 'utf8')).toContain('body');

    // The escape hatch still works for a genuine "I deleted everything".
    const forced = await syncVault(root, { forceReap: true });
    expect(forced.reaped).toBeGreaterThanOrEqual(1);
  });

  test('a legacy bare-id file migrates to the slug path exactly once', async () => {
    await clearDb();
    const { syncVault } = await import('../../src/adapters/vault/sync.ts');
    const id = await createResearch('Legacy layout', 'legacy body');

    // Recreate the pre-v2 state: bare-id filename, okfVersion 1.
    const slugPath = researchPath('legacy-layout', id);
    const legacyRel = researchRel(`${id}.md`);
    const doc = parseVaultDoc(await readFile(slugPath, 'utf8'))!;
    await seedVaultFile(legacyRel, { ...doc.meta, okfVersion: 1 }, doc.body);
    await rm(slugPath);

    // The forward pass rewrites at the new path, and the writer's own sibling
    // sweep retires the bare-id file — so the migration completes without the
    // reap ever seeing it.
    const stats = await syncVault(root);
    expect(stats.written).toBeGreaterThanOrEqual(1);
    expect(parseVaultDoc(await readFile(slugPath, 'utf8'))!.body).toBe('legacy body');
    await expect(readFile(join(root, legacyRel), 'utf8')).rejects.toThrow();
    expect(parseVaultDoc(await readFile(join(root, '_trash', legacyRel), 'utf8'))!.body).toBe(
      'legacy body',
    );

    const again = await syncVault(root);
    expect(again.written).toBe(0);
    expect(again.relocated).toBe(0);
  });

  // `relocated` covers what the writer's sweep cannot: a file already in sync
  // at its current path, with a stale sibling from a title the service never
  // saw change (edited while it was down, or a half-finished rename).
  test('a stale same-id sibling is relocated even when the live file is in sync', async () => {
    await clearDb();
    const { syncVault } = await import('../../src/adapters/vault/sync.ts');
    const id = await createResearch('Settled title', 'settled body');
    await syncVault(root); // reach a steady state first

    const staleRel = researchRel(`an-older-title--${id}.md`);
    const doc = parseVaultDoc(await readFile(researchPath('settled-title', id), 'utf8'))!;
    await seedVaultFile(staleRel, doc.meta, 'stale body');

    const stats = await syncVault(root);
    expect(stats.written).toBe(0); // the live file was already in sync
    expect(stats.relocated).toBe(1);
    await expect(readFile(join(root, staleRel), 'utf8')).rejects.toThrow();
    expect(parseVaultDoc(await readFile(join(root, '_trash', staleRel), 'utf8'))!.body).toBe(
      'stale body',
    );
  });

  test('a generated _index.md links the project and survives the reap', async () => {
    await clearDb();
    const { syncVault } = await import('../../src/adapters/vault/sync.ts');
    const id = await createResearch('Indexed item', 'body');

    const first = await syncVault(root);
    expect(first.indexes).toBeGreaterThanOrEqual(1);
    const indexPath = join(root, 'projects', PROJECT, '_index.md');
    const index = await readFile(indexPath, 'utf8');
    expect(index).toContain('## Research');
    expect(index).toContain(`indexed-item--${id}|Indexed item]]`);

    // It has no graph node, so the reap must not treat it as an orphan, and
    // it must not be rewritten when nothing changed.
    await backdate(indexPath);
    const again = await syncVault(root);
    expect(again.indexes).toBe(0);
    expect(again.reaped).toBe(0);
    expect(await readFile(indexPath, 'utf8')).toBe(index);
  });

  test('--dry-run reports the work without touching the vault', async () => {
    await clearDb();
    const { syncVault } = await import('../../src/adapters/vault/sync.ts');
    const strayId = '3f2a0000-0000-4000-8000-0000000000ee';
    const strayRel = researchRel(`dry--${strayId}.md`);
    await seedVaultFile(strayRel, researchMeta(strayId, 'Dry'), 'dry body');

    const stats = await syncVault(root, { dryRun: true, forceReap: true });
    expect(stats.reaped).toBeGreaterThanOrEqual(1);
    // Still there: the whole point of a dry run.
    expect(await readFile(join(root, strayRel), 'utf8')).toContain('dry body');
  });

  test('purgeTrash empties _trash and refuses a root too close to /', async () => {
    const { purgeTrash } = await import('../../src/adapters/vault/sync.ts');
    await container.vault!.writeRaw(
      join('_trash', researchRel('a--b.md')),
      serializeVaultDoc(
        researchMeta('b', 'A', { deletedAt: STAMP, deleteReason: 'orphaned' }),
        'trashed',
      ),
    );
    const removed = await purgeTrash(root);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await readdir(join(root, '_trash')).catch(() => [])).toEqual([]);

    await expect(purgeTrash('/tmp')).rejects.toThrow(/too close to/);
  });
});

// The dashboard's "open as markdown" must not become a second, drifting
// definition of what a node's markdown is. It reuses the vault serializer, so
// these assertions pin byte equality with the file on disk.
describe('dashboard markdown view', () => {
  test('research markdown is byte-identical to the vault file', async () => {
    await clearDb();
    const content = '# Findings\n\n- p99 regressed\n- traced to the retry loop';
    const id = await createResearch('Drift guard', content);
    const onDisk = await readFile(researchPath('drift-guard', id), 'utf8');

    const res = await app.inject({
      method: 'GET',
      url: `/dashboard/api/research/${id}/markdown`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.markdown).toBe(onDisk);
    expect(res.json().data.filename).toBe(`drift-guard--${id}.md`);
  });

  test('knowledge document markdown is byte-identical to the vault file', async () => {
    await clearDb();
    const created = await app.inject({
      method: 'POST',
      url: '/knowledge/documents',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'Shared doc', source: 'manual', content: 'a shared knowledge note' },
    });
    const id = created.json().data.id as string;
    const onDisk = await readFile(
      join(root, 'shared', 'documents', `shared-doc--${id}.md`),
      'utf8',
    );

    const res = await app.inject({
      method: 'GET',
      url: `/dashboard/api/knowledge/documents/${id}/markdown`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.markdown).toBe(onDisk);
  });

  // Existence is itself scoped: asking for another project's record must look
  // identical to the record not existing.
  test('cross-project research id reports notFound, not forbidden', async () => {
    await clearDb();
    const id = await createResearch('Scoped', 'body');

    const other = await app.inject({
      method: 'GET',
      url: `/dashboard/api/research/${id}/markdown?projectId=someone-else`,
      headers: auth,
    });
    expect(other.statusCode).toBe(404);

    const own = await app.inject({
      method: 'GET',
      url: `/dashboard/api/research/${id}/markdown?projectId=${PROJECT}`,
      headers: auth,
    });
    expect(own.statusCode).toBe(200);
  });
});
