// The generated `_index.md`. Determinism is the load-bearing property: the
// sync byte-compares before writing, so any nondeterminism (a timestamp, a
// locale-sensitive sort) would make every sweep report a change and turn
// "idempotent" into a lie.

import { describe, expect, test } from 'vitest';
import { parseVaultDoc } from '../../src/adapters/vault/frontmatter.ts';
import { type IndexEntry, renderVaultIndex } from '../../src/adapters/vault/index-doc.ts';

const entries: IndexEntry[] = [
  {
    kind: 'research',
    id: 'b',
    title: 'Zebra findings',
    relPath: 'projects/p/research/zebra-findings--b.md',
  },
  {
    kind: 'research',
    id: 'a',
    title: 'Alpha findings',
    relPath: 'projects/p/research/alpha-findings--a.md',
  },
  {
    kind: 'knowledge_document',
    id: 'c',
    title: 'A note',
    relPath: 'projects/p/documents/a-note--c.md',
  },
];

describe('renderVaultIndex', () => {
  test('is byte-identical across renders and independent of input order', () => {
    const once = renderVaultIndex({ projectId: 'p' }, entries);
    const twice = renderVaultIndex({ projectId: 'p' }, [...entries].reverse());
    expect(once).toBe(twice);
  });

  test('carries no timestamp, so an unchanged project produces no write', () => {
    expect(renderVaultIndex({ projectId: 'p' }, entries)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('groups by kind and links to the vault-root-relative path without extension', () => {
    const out = renderVaultIndex({ projectId: 'p' }, entries);
    expect(out).toContain('## Research');
    expect(out).toContain('## Documents');
    expect(out).toContain('[[projects/p/research/alpha-findings--a|Alpha findings]]');
    expect(out).not.toContain('--a.md|');
  });

  test('sorts entries by title within a kind', () => {
    const out = renderVaultIndex({ projectId: 'p' }, entries);
    expect(out.indexOf('Alpha findings')).toBeLessThan(out.indexOf('Zebra findings'));
  });

  test('frontmatter records the counts and marks the note generated', () => {
    const parsed = parseVaultDoc(renderVaultIndex({ projectId: 'p' }, entries))!;
    const meta = parsed.meta as unknown as {
      kind: string;
      generated: boolean;
      counts: { research: number; documents: number };
    };
    expect(meta.kind).toBe('index');
    expect(meta.generated).toBe(true);
    expect(meta.counts).toEqual({ research: 2, documents: 1 });
  });

  // '[', ']' and '|' would terminate the wikilink early and break every link
  // after it in the file.
  test('escapes characters that would terminate a wikilink', () => {
    const out = renderVaultIndex({ projectId: 'p' }, [
      { kind: 'research', id: 'x', title: 'a ]] b | c', relPath: 'projects/p/research/x--x.md' },
    ]);
    expect(out).toContain('[[projects/p/research/x--x|a b c]]');
  });

  test('falls back to the id when a title has nothing left after escaping', () => {
    const out = renderVaultIndex({ projectId: 'p' }, [
      { kind: 'research', id: 'x', title: '|||', relPath: 'projects/p/research/x--x.md' },
    ]);
    expect(out).toContain('|x]]');
  });

  test('an empty bucket renders a valid note with no sections', () => {
    const out = renderVaultIndex({}, []);
    expect(parseVaultDoc(out)).not.toBeNull();
    expect(out).toContain('# Shared');
    expect(out).not.toContain('## Research');
  });
});
