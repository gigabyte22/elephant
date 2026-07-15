import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { newId } from '../../utils/ids.ts';
import type { BlobStore, StoredBlob } from './types.ts';

// Filesystem blob store. Files live under `root`, sharded by the first two
// characters of the blobId to keep any single directory small.
export function createFsBlobStore(root: string): BlobStore {
  const baseDir = resolve(root);

  function pathFor(blobId: string): string {
    return join(baseDir, blobId.slice(0, 2), blobId);
  }

  return {
    async put(data: Buffer): Promise<StoredBlob> {
      const blobId = newId();
      const sha256 = createHash('sha256').update(data).digest('hex');
      const dest = pathFor(blobId);
      await mkdir(dirname(dest), { recursive: true });
      // Write to a temp sibling then rename for atomic visibility.
      const tmp = `${dest}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, dest);
      return { blobId, sha256, size: data.byteLength };
    },

    async getStream(blobId: string): Promise<Readable> {
      return createReadStream(pathFor(blobId));
    },

    async size(blobId: string): Promise<number | null> {
      try {
        return (await stat(pathFor(blobId))).size;
      } catch {
        return null;
      }
    },

    async delete(blobId: string): Promise<void> {
      await rm(pathFor(blobId), { force: true });
    },
  };
}
