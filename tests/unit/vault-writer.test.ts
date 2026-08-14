// Pure-fs tests for the OKF vault writer — no Neo4j needed.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type NarrativeItem,
  parseVaultDoc,
  pathFor,
  sanitizeSegment,
  serializeVaultDoc,
  slugify,
  vaultDocFor,
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
const TITLE = 'Neo4j vs dual-store for agent memory';
const SLUG = 'neo4j-vs-dual-store-for-agent-memory';
const RESEARCH_DIR = 'projects/elephant/research';
// The filename every write under the default meta() lands on.
const FILE = `${SLUG}--${ID}.md`;

function liveDir(): string {
  return join(root, RESEARCH_DIR);
}

function livePath(file: string): string {
  return join(liveDir(), file);
}

function trashPath(file: string): string {
  return join(root, '_trash', RESEARCH_DIR, file);
}

function meta(overrides: Partial<VaultFrontmatter> = {}): VaultFrontmatter {
  return {
    okfVersion: 2,
    id: ID,
    kind: 'research',
    title: TITLE,
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

function item(overrides: Partial<NarrativeItem> = {}): NarrativeItem {
  return {
    id: ID,
    title: TITLE,
    source: 'manual',
    content: 'the full body',
    contentHash: 'abc123',
    summary: 'a distilled summary',
    tags: ['architecture'],
    createdAt: new Date('2026-07-20T13:00:00Z'),
    updatedAt: new Date('2026-07-20T13:00:00Z'),
    projectId: 'elephant',
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

// Titles are user text and reach the filesystem, so this is the hostile-input
// surface. Unlike sanitizeSegment, a slug is allowed to lose information —
// pathFor keeps identity in the id suffix.
describe('slugify', () => {
  test('normal titles become readable hyphenated slugs', () => {
    expect(slugify(TITLE)).toBe(SLUG);
    expect(slugify('Golf Pre-Appointment Checklist & Drills')).toBe(
      'golf-pre-appointment-checklist-drills',
    );
  });

  test('punctuation, em dashes and emoji collapse away', () => {
    expect(slugify('Financial Education — “I might buy a NEW STOCK‼️”')).toBe(
      'financial-education-i-might-buy-a-new-stock',
    );
    expect(slugify('café RÉSUMÉ')).toBe('cafe-resume');
  });

  test('a title with nothing sluggable yields the empty string', () => {
    expect(slugify('‼️🎉')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  test('long titles are cut at a word boundary', () => {
    const slug = slugify(`${'alpha bravo charlie delta echo foxtrot golf hotel '.repeat(3)}india`);
    expect(slug.length).toBeLessThanOrEqual(72);
    expect(slug.endsWith('-')).toBe(false);
  });

  test('output has no hyphen runs, so -- stays an unambiguous separator', () => {
    expect(slugify('a -- b')).toBe('a-b');
    expect(slugify('a/b')).toBe('a-b');
  });

  test('is idempotent', () => {
    for (const t of [TITLE, 'a -- b', 'café RÉSUMÉ', 'x']) {
      expect(slugify(slugify(t))).toBe(slugify(t));
    }
  });
});

describe('pathFor', () => {
  test('a titled ref gets a slug filename with the id suffix', () => {
    expect(pathFor({ kind: 'research', id: ID, projectId: 'elephant', title: TITLE })).toBe(
      join('projects/elephant/research', `${SLUG}--${ID}.md`),
    );
  });

  test('an untitled ref still carries the id suffix', () => {
    expect(pathFor({ kind: 'research', id: ID, projectId: 'elephant' })).toBe(
      join('projects/elephant/research', `untitled--${ID}.md`),
    );
  });

  test('traversal-hostile projectIds stay inside the vault', () => {
    const rel = pathFor({ kind: 'research', id: ID, projectId: '../../etc', title: TITLE });
    expect(rel.startsWith('projects/')).toBe(true);
    // Traversal needs a '..' path segment; '..' as a substring inside a
    // sanitized single segment is harmless.
    expect(rel.split('/').every((segment) => segment !== '..')).toBe(true);
  });

  test('traversal-hostile titles stay inside the vault', () => {
    for (const hostile of ['../../etc/passwd', 'a/b', 'C:\\x', '..', '.', '‼️', 'x'.repeat(300)]) {
      const rel = pathFor({ kind: 'research', id: ID, projectId: 'elephant', title: hostile });
      const file = rel.split('/').pop() ?? '';
      expect(rel.split('/').every((segment) => segment !== '..')).toBe(true);
      expect(file).not.toContain('\\');
      expect(file.endsWith(`--${ID}.md`)).toBe(true);
      expect(file.length).toBeLessThanOrEqual(120);
    }
  });
});

// The A1 predicate: frontmatter is metadata, so `summary` only earns its place
// when it says something the body does not.
describe('vaultDocFor summary predicate', () => {
  test('omits the summary when it is the body verbatim', () => {
    const { meta: m } = vaultDocFor(
      'research',
      item({ content: 'same text', summary: 'same text' }),
    );
    expect(m.summary).toBeUndefined();
  });

  test('omits the summary when the body merely opens with it', () => {
    const { meta: m } = vaultDocFor(
      'research',
      item({ content: 'same text\n\nplus more', summary: 'same text' }),
    );
    expect(m.summary).toBeUndefined();
  });

  test('omits an empty summary', () => {
    const { meta: m } = vaultDocFor('research', item({ summary: '   ' }));
    expect(m.summary).toBeUndefined();
  });

  test('keeps a genuinely distinct summary verbatim', () => {
    const { meta: m } = vaultDocFor('research', item({ summary: 'A distilled finding.' }));
    expect(m.summary).toBe('A distilled finding.');
    expect(m.summaryTruncated).toBeUndefined();
  });

  test('clips a very long distinct summary and flags it', () => {
    const long = `${'word '.repeat(400)}end`;
    const { meta: m } = vaultDocFor('research', item({ summary: long }));
    expect(m.summary!.length).toBeLessThanOrEqual(1001);
    expect(m.summary!.endsWith('…')).toBe(true);
    expect(m.summaryTruncated).toBe(true);
  });

  // Pre-OKF rows have no content, so bodyFor emits the summary plus a marker.
  // The body opens with the summary, so the same one rule drops it.
  test('a pre-OKF record keeps its summary in the body, not the frontmatter', () => {
    const { meta: m, body } = vaultDocFor(
      'research',
      item({ content: undefined, summary: 'Only a summary.' }),
    );
    expect(m.summary).toBeUndefined();
    expect(body).toContain('Only a summary.');
    expect(body).toContain('body not retained');
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
  test('write lands at the slug path with parseable frontmatter; no tmp residue', async () => {
    const vault = createFsVaultWriter(root);
    await vault.write(meta(), 'the full body');

    const parsed = parseVaultDoc(await readFile(livePath(FILE), 'utf8'));
    expect(parsed!.meta.contentHash).toBe('abc123');
    expect(parsed!.body).toBe('the full body');

    const files = await readdir(liveDir());
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  test('unscoped knowledge document lands under shared/documents', async () => {
    const vault = createFsVaultWriter(root);
    await vault.write(meta({ kind: 'knowledge_document', projectId: undefined }), 'shared doc');
    const raw = await readFile(join(root, 'shared/documents', `${SLUG}--${ID}.md`), 'utf8');
    expect(parseVaultDoc(raw)!.body).toBe('shared doc');
  });

  // A title edit moves the slug path. Without the sweep the vault would show
  // two files for one node until the next nightly sync.
  test('rewriting under a new title removes the old file instead of duplicating', async () => {
    const vault = createFsVaultWriter(root);
    await vault.write(meta(), 'first body');
    await vault.write(meta({ title: 'A completely different title' }), 'second body');

    const files = await readdir(liveDir());
    expect(files).toEqual([`a-completely-different-title--${ID}.md`]);

    const trashed = parseVaultDoc(await readFile(trashPath(FILE), 'utf8'))!;
    expect(trashed.body).toBe('first body');
    expect(trashed.meta.deleteReason).toBe('orphaned');
  });

  test('tombstone moves the live file to _trash with deletedAt/deleteReason', async () => {
    const vault = createFsVaultWriter(root);
    await vault.write(meta(), 'doomed body');
    await vault.tombstone(
      { id: ID, kind: 'research', projectId: 'elephant', title: TITLE },
      new Date('2026-07-20T14:00:00Z'),
      'soft_delete',
    );

    await expect(readFile(livePath(FILE), 'utf8')).rejects.toThrow();

    const parsed = parseVaultDoc(await readFile(trashPath(FILE), 'utf8'))!;
    expect(parsed.meta.deletedAt).toBe('2026-07-20T14:00:00.000Z');
    expect(parsed.meta.deleteReason).toBe('soft_delete');
    expect(parsed.body).toBe('doomed body');
    expect(parsed.meta.title).toBe(TITLE);
  });

  test('tombstone finds the file by id when the ref carries no title', async () => {
    const vault = createFsVaultWriter(root);
    await vault.write(meta(), 'doomed body');
    await vault.tombstone(
      { id: ID, kind: 'research', projectId: 'elephant' },
      new Date('2026-07-20T14:00:00Z'),
      'soft_delete',
    );
    const parsed = parseVaultDoc(await readFile(trashPath(FILE), 'utf8'))!;
    expect(parsed.body).toBe('doomed body');
  });

  // The regression the id scan exists to prevent: a stale title would compute
  // a path that misses, and the tombstone would degrade to an empty stub while
  // leaving the real file live.
  test('tombstone still finds the file when the ref title is out of date', async () => {
    const vault = createFsVaultWriter(root);
    await vault.write(meta(), 'doomed body');
    await vault.tombstone(
      { id: ID, kind: 'research', projectId: 'elephant', title: 'a stale title' },
      new Date('2026-07-20T14:00:00Z'),
      'soft_delete',
    );

    expect(await readdir(liveDir())).toEqual([]);
    const parsed = parseVaultDoc(await readFile(trashPath(FILE), 'utf8'))!;
    expect(parsed.body).toBe('doomed body');
  });

  test('tombstone finds a not-yet-migrated bare-id file', async () => {
    const vault = createFsVaultWriter(root);
    const legacyRel = join(RESEARCH_DIR, `${ID}.md`);
    await vault.writeRaw(legacyRel, serializeVaultDoc(meta({ okfVersion: 1 }), 'legacy body'));

    await vault.tombstone(
      { id: ID, kind: 'research', projectId: 'elephant', title: TITLE },
      new Date('2026-07-20T14:00:00Z'),
      'soft_delete',
    );

    expect(await readdir(liveDir())).toEqual([]);
    const parsed = parseVaultDoc(await readFile(join(root, '_trash', legacyRel), 'utf8'))!;
    expect(parsed.body).toBe('legacy body');
    expect(parsed.meta.deleteReason).toBe('soft_delete');
  });

  test('tombstone of a never-written item creates a frontmatter-only stub', async () => {
    const vault = createFsVaultWriter(root);
    await vault.tombstone(
      { id: ID, kind: 'research', projectId: 'elephant' },
      new Date('2026-07-20T14:00:00Z'),
      'expired',
    );
    const parsed = parseVaultDoc(await readFile(trashPath(`untitled--${ID}.md`), 'utf8'))!;
    expect(parsed.meta.deleteReason).toBe('expired');
    expect(parsed.meta.id).toBe(ID);
    expect(parsed.meta.okfVersion).toBe(2);
    expect(parsed.body).toBe('');
  });

  test('tombstoneFile moves exactly the path it is given', async () => {
    const vault = createFsVaultWriter(root);
    const rel = join(RESEARCH_DIR, `stray--${ID}.md`);
    await vault.writeRaw(rel, serializeVaultDoc(meta(), 'stray body'));
    await vault.tombstoneFile(rel, new Date('2026-07-20T14:00:00Z'), 'orphaned');

    await expect(readFile(join(root, rel), 'utf8')).rejects.toThrow();
    const parsed = parseVaultDoc(await readFile(join(root, '_trash', rel), 'utf8'))!;
    expect(parsed.meta.deleteReason).toBe('orphaned');
    expect(parsed.body).toBe('stray body');
  });

  test('tombstoneFile leaves a file it cannot parse alone', async () => {
    const vault = createFsVaultWriter(root);
    const rel = join(RESEARCH_DIR, 'not-okf.md');
    await vault.writeRaw(rel, 'just some notes, no frontmatter\n');
    await vault.tombstoneFile(rel, new Date(), 'orphaned');
    expect(await readFile(join(root, rel), 'utf8')).toContain('just some notes');
  });
});
