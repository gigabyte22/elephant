// Binary blob storage for knowledge attachments. Keeps the bytes out of Neo4j;
// the graph holds only metadata (filename, mimeType, sha256, blobId) on
// :KnowledgeAttachment nodes and references the blob by id.
import type { Readable } from 'node:stream';

export interface StoredBlob {
  blobId: string;
  sha256: string;
  size: number;
}

export interface BlobStore {
  /** Persist bytes; returns the generated blobId + content hash + size. */
  put(data: Buffer): Promise<StoredBlob>;
  /** Open a read stream for a stored blob. Throws if missing. */
  getStream(blobId: string): Promise<Readable>;
  /** Total byte size of a stored blob, or null when absent. */
  size(blobId: string): Promise<number | null>;
  /** Remove a blob. No-op when already gone. */
  delete(blobId: string): Promise<void>;
}
