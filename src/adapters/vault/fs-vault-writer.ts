// Filesystem OKF vault writer. Layout under root:
//
//   projects/{projectId}/research/{id}.md
//   projects/{projectId}/documents/{id}.md   (knowledge docs with a project)
//   shared/documents/{id}.md                 (knowledge docs without scope)
//   _trash/<same relative path>              (tombstones)
//
// Writes use the temp-sibling + rename idiom (see fs-blob-store) so a reader
// never observes a half-written file; last-writer-wins is acceptable for a
// derived projection.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseVaultDoc, pathFor, serializeVaultDoc } from './frontmatter.ts';
import type { VaultDeleteReason, VaultFrontmatter, VaultRef, VaultWriter } from './types.ts';

export function createFsVaultWriter(root: string): VaultWriter {
  const baseDir = resolve(root);

  async function writeAtomic(dest: string, content: string): Promise<void> {
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, dest);
  }

  return {
    async write(meta: VaultFrontmatter, body: string): Promise<void> {
      const dest = join(baseDir, pathFor(meta.kind, meta.id, meta.projectId));
      await writeAtomic(dest, serializeVaultDoc(meta, body));
    },

    async tombstone(ref: VaultRef, at: Date, reason: VaultDeleteReason): Promise<void> {
      const relPath = pathFor(ref.kind, ref.id, ref.projectId);
      const livePath = join(baseDir, relPath);
      const trashPath = join(baseDir, '_trash', relPath);

      let live: string | null = null;
      try {
        live = await readFile(livePath, 'utf8');
      } catch {
        live = null;
      }

      const stamped: Partial<VaultFrontmatter> = {
        deletedAt: at.toISOString(),
        deleteReason: reason,
      };
      const parsed = live !== null ? parseVaultDoc(live) : null;
      const doc = parsed
        ? serializeVaultDoc({ ...parsed.meta, ...stamped }, parsed.body)
        : // Never-written (or unparseable) item: frontmatter-only stub so the
          // tombstone still records what was deleted and when.
          serializeVaultDoc(
            {
              okfVersion: 1,
              id: ref.id,
              kind: ref.kind,
              title: '(unknown — no vault file existed at deletion)',
              ...(ref.projectId !== undefined && { projectId: ref.projectId }),
              source: 'unknown',
              tags: [],
              createdAt: at.toISOString(),
              updatedAt: at.toISOString(),
              ...stamped,
            },
            '',
          );

      await writeAtomic(trashPath, doc);
      await rm(livePath, { force: true });
    },
  };
}
