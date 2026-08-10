// Deferred + repeatable attachment extraction.
//
// Extraction of image/audio attachments does not run in the upload request: a
// vision call takes seconds to minutes, while the calling client aborts at 30s
// and retries, and attachment creation is a non-idempotent CREATE with a
// per-request blob write — so an inline slow path produced duplicate
// attachments while returning an error. Uploads park the row as 'pending' and a
// background worker calls reextractAttachment.
//
// That makes re-extraction a routine operation rather than a repair, so the
// property that matters is that running it twice replaces an attachment's
// chunks instead of accumulating them. These specs pin that, plus the exact
// sequence the worker performs, using injected fakes so no provider is called.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  createFakeBlobStore,
  createFakeEmbeddingAdapter,
  createFakeExtractionService,
  createFakeLLMAdapter,
} from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { KnowledgeAttachmentRepository } from '../../src/repositories/KnowledgeAttachmentRepository.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const PROJECT = 'proj-extraction';

// Long enough to chunk into more than one piece, so "chunks were replaced" is a
// meaningful assertion rather than a 1-vs-1 comparison.
const OCR_TEXT = Array.from(
  { length: 40 },
  (_, i) => `Line ${i}: transcribed text from the attachment, repeated to force multiple chunks.`,
).join('\n');
const REVISED_TEXT = 'A shorter second reading of the same bytes.';

let container: Container;
let blobStore: ReturnType<typeof createFakeBlobStore>;
let extraction: ReturnType<typeof createFakeExtractionService>;

async function chunkCount(attachmentId: string): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(
      'MATCH (c:KnowledgeChunk {attachmentId: $attachmentId}) RETURN count(c) AS n',
      { attachmentId },
    );
    return Number(r.records[0]?.get('n') ?? 0);
  });
}

async function makeDocument(): Promise<string> {
  const doc = await container.knowledge.ingest({
    title: 'Note with an attachment',
    source: 'test',
    content: 'The note body, which has its own chunks that must survive a re-extraction.',
    scope: { projectId: PROJECT },
  });
  return doc.id;
}

async function attach(documentId: string, mimeType = 'image/jpeg'): Promise<string> {
  const att = await container.knowledge.addAttachment(documentId, {
    filename: 'photo.jpg',
    mimeType,
    dataBase64: Buffer.from('pretend-image-bytes').toString('base64'),
  });
  return att.id;
}

beforeAll(async () => {
  blobStore = createFakeBlobStore();
  extraction = createFakeExtractionService({
    'image/': { status: 'done', text: OCR_TEXT, detail: 'fake-vision', derivation: 'model' },
  });
  container = await bootstrap({
    llm: createFakeLLMAdapter({}),
    embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
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

describe('reextractAttachment', () => {
  test('indexes the extracted text as chunks carrying the attachment id', async () => {
    const documentId = await makeDocument();
    const attachmentId = await attach(documentId);

    const before = await chunkCount(attachmentId);
    const updated = await container.knowledge.reextractAttachment(attachmentId);

    expect(updated.extractionStatus).toBe('done');
    expect(updated.extractedChars).toBe(OCR_TEXT.length);
    expect(updated.detail).toBe('fake-vision');
    expect(await chunkCount(attachmentId)).toBeGreaterThan(1);
    // Sanity: the first extraction already produced these, so re-running is
    // replacing a populated set, not filling an empty one.
    expect(before).toBeGreaterThan(0);
  });

  test('replaces rather than accumulates chunks when run repeatedly', async () => {
    const documentId = await makeDocument();
    const attachmentId = await attach(documentId);

    const first = await container.knowledge.reextractAttachment(attachmentId);
    const afterFirst = await chunkCount(attachmentId);
    const second = await container.knowledge.reextractAttachment(attachmentId);
    const afterSecond = await chunkCount(attachmentId);

    // The guard against the backfill and the worker doubling an attachment's
    // contribution to the index every time either one touches it.
    expect(afterSecond).toBe(afterFirst);
    expect(second.extractedChars).toBe(first.extractedChars);
  });

  test('leaves the parent document body chunks alone', async () => {
    const documentId = await makeDocument();
    const bodyChunks = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (c:KnowledgeChunk {documentId: $documentId})
         WHERE c.attachmentId IS NULL RETURN count(c) AS n`,
        { documentId },
      );
      return Number(r.records[0]?.get('n') ?? 0);
    });
    const attachmentId = await attach(documentId);

    await container.knowledge.reextractAttachment(attachmentId);

    const stillThere = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (c:KnowledgeChunk {documentId: $documentId})
         WHERE c.attachmentId IS NULL RETURN count(c) AS n`,
        { documentId },
      );
      return Number(r.records[0]?.get('n') ?? 0);
    });
    expect(bodyChunks).toBeGreaterThan(0);
    expect(stillThere).toBe(bodyChunks);
  });

  test('shrinking output drops the chunks the longer text had created', async () => {
    const documentId = await makeDocument();
    const attachmentId = await attach(documentId);
    const long = await chunkCount(attachmentId);

    // A second reading of the same bytes — a different model, or a prompt
    // change — must not leave the previous transcription's tail behind.
    const shortExtraction = createFakeExtractionService({
      'image/': { status: 'done', text: REVISED_TEXT, detail: 'fake-vision-2' },
    });
    const shortContainer = await bootstrap({
      llm: createFakeLLMAdapter({}),
      embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
      extraction: shortExtraction,
      blobStore,
    });
    const updated = await shortContainer.knowledge.reextractAttachment(attachmentId);

    expect(updated.extractedChars).toBe(REVISED_TEXT.length);
    expect(await chunkCount(attachmentId)).toBeLessThan(long);
  });
});

describe('provenance and reassembly', () => {
  test('marks attachment chunks as model-derived, leaving body chunks verbatim', async () => {
    const documentId = await makeDocument();
    const attachmentId = await attach(documentId);

    const derivations = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (c:KnowledgeChunk {documentId: $documentId})
         RETURN c.attachmentId IS NOT NULL AS fromAttachment,
                collect(DISTINCT c.derivation) AS derivations`,
        { documentId },
      );
      return Object.fromEntries(
        r.records.map((rec) => [
          rec.get('fromAttachment') ? 'attachment' : 'body',
          rec.get('derivations') as string[],
        ]),
      );
    });

    // OCR is the model's reading of an image, not the image's own words. A
    // consumer quoting recalled text needs to be able to tell the difference.
    expect(derivations.attachment).toEqual(['model']);
    expect(derivations.body).toEqual(['verbatim']);
    expect(attachmentId).toBeTruthy();
  });

  test('reassembles attachment text without repeating the chunk overlap', async () => {
    const documentId = await makeDocument();
    const attachmentId = await attach(documentId);

    const loaded = await container.knowledge.getWithAttachments(documentId);
    const text = loaded?.attachmentTexts[attachmentId] ?? '';

    // Chunks are written with CHUNK_OVERLAP_TOKENS of their predecessor
    // prepended, so joining them naively repeated a stretch of every seam.
    // Each source line must appear exactly once.
    expect(await chunkCount(attachmentId)).toBeGreaterThan(1);
    for (let i = 0; i < 40; i++) {
      expect(text.match(new RegExp(`Line ${i}:`, 'g')) ?? []).toHaveLength(1);
    }
  });
});

describe('the worker sequence', () => {
  test('a pending attachment is claimed, extracted, and leaves the queue', async () => {
    const documentId = await makeDocument();
    const attachmentId = await attach(documentId);
    // Park it exactly as a deferred upload would.
    await write((tx) =>
      KnowledgeAttachmentRepository.update(tx, attachmentId, {
        extractionStatus: 'pending',
        extractedChars: 0,
        detail: 'queued for extraction',
      }),
    );

    const claimed = await container.knowledge.listPendingAttachments(1);
    expect(claimed.map((a) => a.id)).toEqual([attachmentId]);

    await container.knowledge.reextractAttachment(claimed[0]!.id);

    expect(await container.knowledge.listPendingAttachments(1)).toEqual([]);
  });

  test('a structurally failed attachment is recorded, not left to spin', async () => {
    const documentId = await makeDocument();
    const attachmentId = await attach(documentId);

    // What the worker does when extraction throws for a reason the extractors
    // cannot map themselves — a missing blob, an embedder outage. Leaving it
    // 'pending' would re-claim the same row every tick and starve the queue.
    await container.knowledge.markAttachmentFailed(attachmentId, 'blob 123 not found');

    expect(await container.knowledge.listPendingAttachments(1)).toEqual([]);
    const att = await container.knowledge.getAttachment(attachmentId);
    expect(att?.extractionStatus).toBe('failed');
    expect(att?.detail).toBe('blob 123 not found');
  });

  test('a re-extraction reads the stored blob instead of re-uploading', async () => {
    const documentId = await makeDocument();
    const callsBefore = extraction.calls();
    const attachmentId = await attach(documentId);
    const blobsAfterUpload = blobStore.count();

    await container.knowledge.reextractAttachment(attachmentId);

    // One extra extraction call, and crucially no second blob: re-extraction
    // works from bytes already in the store.
    expect(extraction.calls()).toBe(callsBefore + 2);
    expect(blobStore.count()).toBe(blobsAfterUpload);
  });
});
