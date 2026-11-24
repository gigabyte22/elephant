// Integrity of attachment blobs against the graph.
//
// Two failure modes this pins:
//  - an upload that fails after its blob is stored (extraction or embedding
//    throws) used to leave the blob behind, one orphan per client retry, since
//    every put mints a fresh blobId;
//  - a document purge used to run as three separate steps, so a failure after
//    the first left a LIVE document whose attachments and blobs were gone.
// Purge now commits every graph change in one transaction and deletes blobs
// only afterwards, best-effort.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createFakeBlobStore,
  createFakeEmbeddingAdapter,
  createFakeExtractionService,
  createFakeLLMAdapter,
} from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { KnowledgeChunkRepository } from '../../src/repositories/KnowledgeChunkRepository.ts';
import { KnowledgeDocumentRepository } from '../../src/repositories/KnowledgeDocumentRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const PROJECT = 'proj-attachment-integrity';

let container: Container;
let blobStore: ReturnType<typeof createFakeBlobStore>;
let extraction: ReturnType<typeof createFakeExtractionService>;
let embedder: ReturnType<typeof createFakeEmbeddingAdapter>;

async function count(cypher: string, params: Record<string, unknown>): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(cypher, params);
    return Number(r.records[0]?.get('n') ?? 0);
  });
}

function attachmentNodes(documentId: string): Promise<number> {
  return count(
    'MATCH (:KnowledgeDocument {id: $documentId})-[:HAS_ATTACHMENT]->(a:KnowledgeAttachment) RETURN count(a) AS n',
    { documentId },
  );
}

function allAttachmentNodes(): Promise<number> {
  return count('MATCH (a:KnowledgeAttachment) RETURN count(a) AS n', {});
}

function chunks(documentId: string): Promise<number> {
  return count('MATCH (c:KnowledgeChunk {documentId: $documentId}) RETURN count(c) AS n', {
    documentId,
  });
}

async function isLive(documentId: string): Promise<boolean> {
  const doc = await read((tx) => KnowledgeDocumentRepository.get(tx, documentId));
  if (!doc) throw new Error(`document ${documentId} missing`);
  return !doc.expiresAt || doc.expiresAt > new Date();
}

async function makeDocument(): Promise<string> {
  const doc = await container.knowledge.ingest({
    title: 'Note with attachments',
    source: 'test',
    content: 'The note body, chunked and embedded like any other document.',
    scope: { projectId: PROJECT },
  });
  return doc.id;
}

function attach(documentId: string, filename = 'notes.txt') {
  return container.knowledge.addAttachment(documentId, {
    filename,
    mimeType: 'text/plain',
    dataBase64: Buffer.from(`attachment bytes for ${filename}`).toString('base64'),
  });
}

beforeAll(async () => {
  blobStore = createFakeBlobStore();
  extraction = createFakeExtractionService({
    'text/': { status: 'done', text: 'Verbatim attachment text, chunked and embedded inline.' },
  });
  embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  container = await bootstrap({
    llm: createFakeLLMAdapter({}),
    embedder,
    extraction,
    blobStore,
  });
});

afterAll(async () => {
  await shutdown();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  await write(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('addAttachment failure cleanup', () => {
  test.each([
    {
      stage: 'extraction',
      message: 'extractor exploded',
      fail: (err: Error) => vi.spyOn(extraction, 'extract').mockRejectedValueOnce(err),
    },
    {
      stage: 'embedding',
      message: 'embedder offline',
      fail: (err: Error) => vi.spyOn(embedder, 'embedBatch').mockRejectedValueOnce(err),
    },
  ])(
    'an $stage failure removes the stored blob and surfaces the original error',
    async ({ message, fail }) => {
      const documentId = await makeDocument();
      const blobsBefore = blobStore.count();
      fail(new Error(message));

      await expect(attach(documentId)).rejects.toThrow(message);

      expect(blobStore.count()).toBe(blobsBefore);
      expect(await allAttachmentNodes()).toBe(0);
    },
  );

  test('a failing blob cleanup does not mask the original error', async () => {
    const documentId = await makeDocument();
    vi.spyOn(extraction, 'extract').mockRejectedValueOnce(new Error('extractor exploded'));
    vi.spyOn(blobStore, 'delete').mockRejectedValueOnce(new Error('disk gone'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(attach(documentId)).rejects.toThrow('extractor exploded');
    expect(await allAttachmentNodes()).toBe(0);
  });
});

describe('purge', () => {
  test('soft-deletes the document and removes attachment nodes, chunks and blobs', async () => {
    const documentId = await makeDocument();
    const blobsBefore = blobStore.count();
    const a = await attach(documentId, 'a.txt');
    const b = await attach(documentId, 'b.txt');
    expect(blobStore.count()).toBe(blobsBefore + 2);
    const chunksBefore = await chunks(documentId);
    expect(chunksBefore).toBeGreaterThan(1); // body + attachment chunks

    const { chunksDeleted } = await container.knowledge.purge(documentId);

    expect(chunksDeleted).toBe(chunksBefore);
    expect(await isLive(documentId)).toBe(false);
    expect(await attachmentNodes(documentId)).toBe(0);
    expect(await chunks(documentId)).toBe(0);
    expect(await blobStore.size(a.blobId)).toBeNull();
    expect(await blobStore.size(b.blobId)).toBeNull();
    expect(blobStore.count()).toBe(blobsBefore);
  });

  test('a failing blob delete still completes the purge', async () => {
    const documentId = await makeDocument();
    const att = await attach(documentId);
    vi.spyOn(blobStore, 'delete').mockRejectedValue(new Error('disk gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { chunksDeleted } = await container.knowledge.purge(documentId);

    expect(chunksDeleted).toBeGreaterThan(0);
    expect(await isLive(documentId)).toBe(false);
    expect(await attachmentNodes(documentId)).toBe(0);
    expect(await chunks(documentId)).toBe(0);
    // The file is left behind (harmless) and the failure is logged.
    expect(await blobStore.size(att.blobId)).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  test('a failed transaction leaves the document live with its attachments and blobs', async () => {
    const documentId = await makeDocument();
    const att = await attach(documentId);
    const chunksBefore = await chunks(documentId);
    // Fail the last graph step, after the soft delete and the attachment delete
    // have run in the same transaction, so a rollback is what keeps them.
    const original = KnowledgeChunkRepository.deleteForDocument;
    vi.spyOn(KnowledgeChunkRepository, 'deleteForDocument').mockImplementationOnce(
      async (tx, id) => {
        await original(tx, id);
        throw new Error('injected purge failure');
      },
    );

    await expect(container.knowledge.purge(documentId)).rejects.toThrow('injected purge failure');

    expect(await isLive(documentId)).toBe(true);
    expect(await attachmentNodes(documentId)).toBe(1);
    expect(await chunks(documentId)).toBe(chunksBefore);
    expect(await blobStore.size(att.blobId)).not.toBeNull();
  });
});
