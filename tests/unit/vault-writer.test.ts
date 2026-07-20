// Pure-fs tests for the OKF vault writer — no Neo4j needed.

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  parseVaultDoc,
  pathFor,
  sanitizeSegment,
  serializeVaultDoc,
} from '../../src/adapters/vault/frontmatter.ts';
import { createFsVaultWriter } from '../../src/adapters/vault/fs-vault-writer.ts';
import type { VaultFrontmatter } from '../../src/adapters/vault/types.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'okf-vault-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ID = '3f2a0000-0000-4000-8000-000000000001';

function meta(overrides: Partial<VaultFrontmatter> = {}): VaultFrontmatter {
  return {
    okfVersion: 1,
    id: ID,
    kind: 'research',
    title: 'Neo4j vs dual-store for agent memory',
    projectId: 'elephant',
    source: 'manual',
    tags: ['architecture', 'memory'],
    createdAt: '2026-07-20T13:00:00.000Z',
    updatedAt: '2026-07-20T13:00:00.000Z',
    contentHash: 'abc123',
    summary: 'a summary',
    ...overrides,
  };
}

describe('sanitizeSegment', () => {
  test('clean segments pass through untouched', () => {
    expect(sanitizeSegment('elephant')).toBe('elephant');
    expect(sanitizeSegment('proj_1.2-x')).toBe('proj_1.2-x');
  });

  test('traversal and separator characters are neutralized with a hash suffix', () => {
    for (const hostile of ['../evil', 'a/b', 'C:\\x', '..', '.', '', 'ünïcode']) {
      const safe = sanitizeSegment(hostile);
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
      expect(safe).toMatch(/-[0-9a-f]{8}$/);
      expect(safe).not.toMatch(/^\.+$/);
    }
  });

  test('inputs that clean to the same text stay distinct', () => {
    expect(sanitizeSegment('a/b')).not.toBe(sanitizeSegment('a_b/'));
    expect(sanitizeSegment('a/b')).not.toBe(sanitizeSegment('a\\b'));
  });
});

describe('serialize/parse round-trip', () => {
  test('hostile titles survive YAML round-trip', () => {
    const hostileTitle = "colon: hash # quote \" newline\nand 'single' --- done";
    const doc = serializeVaultDoc(meta({ title: hostileTitle }), 'body text');
    const parsed = parseVaultDoc(doc);
    expect(parsed).not.toBeNull();
    expect(parsed!.meta.title).toBe(hostileTitle);
    expect(parsed!.meta.id).toBe(ID);
    expect(parsed!.body).toBe('body text');
  });

  test('body round-trips byte-identically including markdown structure', () => {
    const body = '# Findings\n\n- one\n- two\n\n```ts\nconst x = 1;\n```';
    const parsed = parseVaultDoc(serializeVaultDoc(meta(), body));
    expect(parsed!.body).toBe(body);
  });
});

describe('fs vault writer', () => {
  test('write lands at the expected path with parseable frontmatter; no tmp residue', async () => {
    const vault = createFsVaultWriter(root);
    await vault.write(meta(), 'the full body');

    const expected = join(root, 'projects/elephant/research', `${ID}.md`);
    const raw = await readFile(expected, 'utf8');
    const parsed = parseVaultDoc(raw);
    expect(parsed!.meta.contentHash).toBe('abc123');
    expect(parsed!.body).toBe('the full body');

    const files = await readdir(join(root, 'projects/elephant/research'));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  test('unscoped knowledge document lands under shared/documents', async () => {
    const vault = createFsVaultWriter(root);
    await vault.write(meta({ kind: 'knowledge_document', projectId: undefined }), 'shared doc');
    const raw = await readFile(join(root, 'shared/documents', `${ID}.md`), 'utf8');
    expect(parseVaultDoc(raw)!.body).toBe('shared doc');
  });

  test('tombstone moves the live file to _trash with deletedAt/deleteReason', async () => {
    const vault = createFsVaultWriter(root);
    await vault.write(meta(), 'doomed body');
    await vault.tombstone(
      { id: ID, kind: 'research', projectId: 'elephant' },
      new Date('2026-07-20T14:00:00Z'),
      'soft_delete',
    );

    const livePath = join(root, 'projects/elephant/research', `${ID}.md`);
    await expect(readFile(livePath, 'utf8')).rejects.toThrow();

    const trash = await readFile(
      join(root, '_trash/projects/elephant/research', `${ID}.md`),
      'utf8',
    );
    const parsed = parseVaultDoc(trash)!;
    expect(parsed.meta.deletedAt).toBe('2026-07-20T14:00:00.000Z');
    expect(parsed.meta.deleteReason).toBe('soft_delete');
    expect(parsed.body).toBe('doomed body');
    expect(parsed.meta.title).toBe('Neo4j vs dual-store for agent memory');
  });

  test('tombstone of a never-written item creates a frontmatter-only stub', async () => {
    const vault = createFsVaultWriter(root);
    await vault.tombstone(
      { id: ID, kind: 'research', projectId: 'elephant' },
      new Date('2026-07-20T14:00:00Z'),
      'expired',
    );
    const trash = await readFile(
      join(root, '_trash/projects/elephant/research', `${ID}.md`),
      'utf8',
    );
    const parsed = parseVaultDoc(trash)!;
    expect(parsed.meta.deleteReason).toBe('expired');
    expect(parsed.meta.id).toBe(ID);
    expect(parsed.body).toBe('');
  });

  test('pathFor routes traversal-hostile projectIds inside the vault', () => {
    const rel = pathFor('research', ID, '../../etc');
    expect(rel.startsWith('projects/')).toBe(true);
    // Traversal needs a '..' path segment; '..' as a substring inside a
    // sanitized single segment is harmless.
    expect(rel.split('/').every((segment) => segment !== '..')).toBe(true);
  });
});
