// OKF vault integration: services materialize research + knowledge documents
// into a markdown vault after the graph transaction commits, tombstone on
// soft-delete, and never fail the request when the vault writer throws.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { parseVaultDoc } from '../../src/adapters/vault/frontmatter.ts';
import { createFsVaultWriter } from '../../src/adapters/vault/fs-vault-writer.ts';
import type { VaultWriter } from '../../src/adapters/vault/types.ts';
import { write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
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
  const vault: VaultWriter = {
    write: (meta, body) => {
      if (failVault) throw new Error('simulated vault failure');
      return inner.write(meta, body);
    },
    tombstone: (ref, at, reason) => {
      if (failVault) throw new Error('simulated vault failure');
      return inner.tombstone(ref, at, reason);
    },
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

describe('OKF vault projection', () => {
  test('research create → vault file; update → rewritten; delete → _trash tombstone', async () => {
    await clearDb();
    const content = '# Vault findings\n\nThe body lands in markdown.';
    const created = await app.inject({
      method: 'POST',
      url: '/research',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'Vault test', source: 'manual', content, projectId: PROJECT },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().data.id as string;

    const livePath = join(root, 'projects', PROJECT, 'research', `${id}.md`);
    const doc = parseVaultDoc(await readFile(livePath, 'utf8'))!;
    expect(doc.meta.okfVersion).toBe(1);
    expect(doc.meta.kind).toBe('research');
    expect(doc.meta.projectId).toBe(PROJECT);
    expect(doc.meta.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(doc.body).toBe(content);

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
      await readFile(join(root, '_trash', 'projects', PROJECT, 'research', `${id}.md`), 'utf8'),
    )!;
    expect(trash.meta.deleteReason).toBe('soft_delete');
    expect(trash.meta.deletedAt).toBeTruthy();
    expect(trash.body).toBe('revised vault body');
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
      await readFile(join(root, 'shared', 'documents', `${id}.md`), 'utf8'),
    )!;
    expect(doc.meta.kind).toBe('knowledge_document');
    expect(doc.body).toBe('a shared knowledge note');
  });

  test('okf-sync restores a deleted vault file and tombstones lapsed research', async () => {
    await clearDb();
    const { syncVault } = await import('../../scripts/okf-sync.ts');

    const keptContent = 'body that will be restored by sync';
    const kept = await app.inject({
      method: 'POST',
      url: '/research',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'Kept', source: 'manual', content: keptContent, projectId: PROJECT },
    });
    const keptId = kept.json().data.id as string;
    const lapsed = await app.inject({
      method: 'POST',
      url: '/research',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'Lapsed', source: 'manual', content: 'will expire', projectId: PROJECT },
    });
    const lapsedId = lapsed.json().data.id as string;

    // Simulate the crash gap: remove kept's vault file; lapse the other row.
    const keptPath = join(root, 'projects', PROJECT, 'research', `${keptId}.md`);
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
      await readFile(
        join(root, '_trash', 'projects', PROJECT, 'research', `${lapsedId}.md`),
        'utf8',
      ),
    )!;
    expect(trash.meta.deleteReason).toBe('expired');
    expect(trash.body).toBe('will expire');

    // Idempotent: a second pass writes nothing new.
    const again = await syncVault(root);
    expect(again.written).toBe(0);
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

    // And no vault file was produced.
    await expect(
      readFile(join(root, 'projects', PROJECT, 'research', `${id}.md`), 'utf8'),
    ).rejects.toThrow();
  });
});
