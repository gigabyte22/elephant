// Ingestion service for shared/RAG documents (KnowledgeDocument + KnowledgeChunks).
// Mirrors MemoryIngestionService.ingestEpisode: chunks the content with the
// existing Chunker, embeds summary + chunks in one batch, and persists both
// node types atomically.

import { createHash } from 'node:crypto';
import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import type { ExtractionService } from '../adapters/extraction/types.ts';
import type { LLMAdapter } from '../adapters/llm/types.ts';
import type { BlobStore } from '../adapters/storage/types.ts';
import { frontmatterFor } from '../adapters/vault/frontmatter.ts';
import type { VaultWriter } from '../adapters/vault/types.ts';
import { read, write } from '../config/neo4j.ts';
import { badRequest, notFound, payloadTooLarge } from '../http/errors.ts';
import type {
  KnowledgeAttachment,
  KnowledgeChunk,
  KnowledgeDocument,
  Scope,
} from '../models/types.ts';
import { KnowledgeAttachmentRepository } from '../repositories/KnowledgeAttachmentRepository.ts';
import { KnowledgeChunkRepository } from '../repositories/KnowledgeChunkRepository.ts';
import { KnowledgeDocumentRepository } from '../repositories/KnowledgeDocumentRepository.ts';
import { newId } from '../utils/ids.ts';
import { AuditService } from './AuditService.ts';
import { type Chunker, createChunker } from './Chunker.ts';

interface Deps {
  llm: LLMAdapter;
  embedder: EmbeddingAdapter;
  chunker?: Chunker;
  blobStore?: BlobStore;
  extraction?: ExtractionService;
  vault?: VaultWriter;
  config: {
    chunkTargetTokens: number;
    chunkOverlapTokens: number;
    summaryThresholdTokens: number;
    summaryTargetTokens: number;
    embedderMaxInputTokens?: number;
    maxAttachmentBytes?: number;
  };
}

export interface AddAttachmentInput {
  filename: string;
  mimeType: string;
  /** Base64-encoded file bytes. */
  dataBase64: string;
  actor?: string;
}

export interface IngestKnowledgeDocumentInput {
  id?: string;
  title: string;
  source: string;
  sourceUri?: string;
  content: string;
  summary?: string;
  tags?: string[];
  scope?: Scope;
  expiresAt?: Date | null;
  actor?: string;
}

export interface UpdateKnowledgeDocumentInput {
  title?: string;
  // When provided, the document is re-chunked + re-embedded.
  content?: string;
  summary?: string;
  tags?: string[];
  expiresAt?: Date | null;
  actor?: string;
}

export function createKnowledgeIngestionService(deps: Deps) {
  const { llm, embedder, config, vault } = deps;
  const chunker = deps.chunker ?? createChunker({ countTokens: (t) => embedder.countTokens(t) });

  // OKF vault projection runs AFTER the graph transaction commits and is
  // log-and-continue: failing the request post-commit would report a false
  // failure, and scripts/okf-sync.ts is the repair path.
  async function vaultProject(doc: KnowledgeDocument): Promise<void> {
    if (!vault) return;
    try {
      await vault.write(frontmatterFor('knowledge_document', doc), doc.content ?? doc.summary);
    } catch (err) {
      console.error('[okf] vault write failed', { id: doc.id, err });
    }
  }

  async function vaultTombstone(doc: KnowledgeDocument, at: Date): Promise<void> {
    if (!vault) return;
    try {
      await vault.tombstone(
        { id: doc.id, kind: 'knowledge_document', projectId: doc.projectId },
        at,
        'soft_delete',
      );
    } catch (err) {
      console.error('[okf] vault tombstone failed', { id: doc.id, err });
    }
  }

  const embedderLimit = Math.min(
    embedder.maxInputTokens,
    config.embedderMaxInputTokens ?? embedder.maxInputTokens,
  );
  const chunkTarget = Math.min(config.chunkTargetTokens, embedderLimit);

  async function assertSummaryWithinLimit(summary: string): Promise<void> {
    const sumTokens = await embedder.countTokens(summary);
    if (sumTokens > embedderLimit) {
      throw badRequest(
        `summary exceeds embedder limit of ${embedderLimit} tokens (got ~${sumTokens})`,
      );
    }
  }

  // Resolve the text to embed/store as the document summary: an explicit
  // summary (validated), an LLM summary for long content, or the content
  // itself when it's short enough to stand in as its own summary.
  async function resolveSummary(content: string, explicit: string | undefined): Promise<string> {
    if (explicit) {
      await assertSummaryWithinLimit(explicit);
      return explicit;
    }
    const tokens = await embedder.countTokens(content);
    if (tokens > config.summaryThresholdTokens) {
      return llm.summarize({ text: content, targetTokens: config.summaryTargetTokens });
    }
    return content;
  }

  async function ingest(input: IngestKnowledgeDocumentInput): Promise<KnowledgeDocument> {
    const pieces = await chunker.chunk(input.content, {
      maxTokens: chunkTarget,
      overlapTokens: config.chunkOverlapTokens,
    });
    if (pieces.length === 0) {
      throw badRequest('document content is empty after trimming');
    }

    const summary = await resolveSummary(input.content, input.summary);

    const texts = [summary, ...pieces.map((p) => p.text)];
    const vectors = await embedder.embedBatch(texts);
    const summaryVec = vectors[0] ?? [];
    const chunkVecs = vectors.slice(1);

    const now = new Date();
    const documentId = input.id ?? newId();
    const document: KnowledgeDocument = {
      id: documentId,
      title: input.title,
      source: input.source,
      sourceUri: input.sourceUri,
      content: input.content,
      contentHash: createHash('sha256').update(input.content).digest('hex'),
      summary,
      embedding: summaryVec,
      tags: input.tags ?? [],
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
      ...(input.scope ?? {}),
    };

    const chunks: KnowledgeChunk[] = pieces.map((p, i) => ({
      id: newId(),
      documentId,
      position: p.position,
      text: p.text,
      tokenCount: p.tokenCount,
      embedding: chunkVecs[i] ?? [],
      createdAt: now,
      ...(input.scope ?? {}),
    }));

    const created = await write(async (tx) => {
      const doc = await KnowledgeDocumentRepository.create(tx, document);
      await KnowledgeChunkRepository.createForDocument(tx, {
        documentId: doc.id,
        chunks,
      });
      await AuditService.record({
        tx,
        kind: 'create',
        targetId: doc.id,
        targetKind: 'knowledge_document',
        actor: input.actor,
        payload: { source: doc.source, chunkCount: chunks.length },
      });
      return doc;
    });
    await vaultProject(created);
    return created;
  }

  async function update(
    id: string,
    input: UpdateKnowledgeDocumentInput,
  ): Promise<KnowledgeDocument> {
    const existing = await read((tx) => KnowledgeDocumentRepository.get(tx, id));
    if (!existing) throw notFound(`knowledge document ${id}`);
    const scope: Scope = { projectId: existing.projectId, userId: existing.userId };

    const now = new Date();
    let summary: string | undefined;
    let embedding: number[] | undefined;
    let contentHash: string | undefined;
    let chunks: KnowledgeChunk[] | undefined;

    if (input.content !== undefined) {
      // Full content change → re-chunk + re-embed, replacing the chunk set.
      const pieces = await chunker.chunk(input.content, {
        maxTokens: chunkTarget,
        overlapTokens: config.chunkOverlapTokens,
      });
      if (pieces.length === 0) {
        throw badRequest('document content is empty after trimming');
      }
      summary = await resolveSummary(input.content, input.summary);
      const texts = [summary, ...pieces.map((p) => p.text)];
      const vectors = await embedder.embedBatch(texts);
      embedding = vectors[0] ?? [];
      const chunkVecs = vectors.slice(1);
      contentHash = createHash('sha256').update(input.content).digest('hex');
      chunks = pieces.map((p, i) => ({
        id: newId(),
        documentId: id,
        position: p.position,
        text: p.text,
        tokenCount: p.tokenCount,
        embedding: chunkVecs[i] ?? [],
        createdAt: now,
        ...scope,
      }));
    } else if (input.summary !== undefined) {
      // Summary-only change → re-embed the summary so recall stays consistent.
      await assertSummaryWithinLimit(input.summary);
      summary = input.summary;
      embedding = (await embedder.embedBatch([input.summary]))[0] ?? [];
    }

    const updated = await write(async (tx) => {
      const doc = await KnowledgeDocumentRepository.update(tx, id, {
        title: input.title,
        content: input.content,
        summary,
        embedding,
        contentHash,
        tags: input.tags,
        expiresAt: input.expiresAt,
        updatedAt: now,
      });
      if (!doc) throw notFound(`knowledge document ${id}`);
      if (chunks) {
        // Replace only the note-body chunks; attachment-derived chunks persist.
        await KnowledgeChunkRepository.deleteBodyChunks(tx, id);
        await KnowledgeChunkRepository.createForDocument(tx, { documentId: id, chunks });
      }
      await AuditService.record({
        tx,
        kind: 'update',
        targetId: id,
        targetKind: 'knowledge_document',
        actor: input.actor,
        payload: { contentChanged: chunks !== undefined, chunkCount: chunks?.length },
      });
      return doc;
    });
    await vaultProject(updated);
    return updated;
  }

  // Chunk + embed arbitrary text into KnowledgeChunks for a document. Used for
  // attachment-extracted text (carries attachmentId so it can be removed with
  // the attachment). Returns [] when the text yields no chunks.
  async function chunkText(
    text: string,
    scope: Scope,
    opts: { documentId: string; attachmentId?: string },
  ): Promise<KnowledgeChunk[]> {
    const pieces = await chunker.chunk(text, {
      maxTokens: chunkTarget,
      overlapTokens: config.chunkOverlapTokens,
    });
    if (pieces.length === 0) return [];
    const vectors = await embedder.embedBatch(pieces.map((p) => p.text));
    const now = new Date();
    return pieces.map((p, i) => ({
      id: newId(),
      documentId: opts.documentId,
      attachmentId: opts.attachmentId,
      position: p.position,
      text: p.text,
      tokenCount: p.tokenCount,
      embedding: vectors[i] ?? [],
      createdAt: now,
      ...scope,
    }));
  }

  function requireAttachmentDeps(): { blobStore: BlobStore; extraction: ExtractionService } {
    if (!deps.blobStore || !deps.extraction) {
      throw new Error('attachment support not configured (missing blobStore/extraction)');
    }
    return { blobStore: deps.blobStore, extraction: deps.extraction };
  }

  async function getWithAttachments(id: string): Promise<{
    document: KnowledgeDocument;
    attachments: KnowledgeAttachment[];
    /** attachmentId → full extracted text, reassembled from chunks in position order. */
    attachmentTexts: Record<string, string>;
  } | null> {
    return read(async (tx) => {
      const document = await KnowledgeDocumentRepository.get(tx, id);
      if (!document) return null;
      const attachments = await KnowledgeAttachmentRepository.listByDocument(tx, id);
      // Reassemble each attachment's extracted text from its chunks. The raw
      // extraction is never stored whole — only chunked + embedded — so the
      // full document text lives only here. listByDocument already returns
      // chunks in position order, so appending per attachment preserves it.
      const attachmentTexts: Record<string, string> = {};
      if (attachments.length > 0) {
        const chunks = await KnowledgeChunkRepository.listByDocument(tx, id);
        for (const c of chunks) {
          if (!c.attachmentId) continue; // skip body-derived chunks
          const existing = attachmentTexts[c.attachmentId];
          attachmentTexts[c.attachmentId] = existing ? `${existing}\n${c.text}` : c.text;
        }
      }
      return { document, attachments, attachmentTexts };
    });
  }

  async function addAttachment(
    documentId: string,
    input: AddAttachmentInput,
  ): Promise<KnowledgeAttachment> {
    const { blobStore, extraction } = requireAttachmentDeps();
    const maxBytes = config.maxAttachmentBytes ?? 26_214_400;

    const existing = await read((tx) => KnowledgeDocumentRepository.get(tx, documentId));
    if (!existing) throw notFound(`knowledge document ${documentId}`);

    const data = Buffer.from(input.dataBase64, 'base64');
    if (data.byteLength === 0) throw badRequest('attachment is empty');
    if (data.byteLength > maxBytes) {
      throw payloadTooLarge(`attachment exceeds ${maxBytes} bytes (got ${data.byteLength})`);
    }

    const scope: Scope = { projectId: existing.projectId, userId: existing.userId };
    const stored = await blobStore.put(data);
    const extracted = await extraction.extract({
      data,
      mimeType: input.mimeType,
      filename: input.filename,
    });

    const attachmentId = newId();
    const chunks =
      extracted.text.length > 0
        ? await chunkText(extracted.text, scope, { documentId, attachmentId })
        : [];

    const attachment: KnowledgeAttachment = {
      id: attachmentId,
      documentId,
      filename: input.filename,
      mimeType: input.mimeType,
      size: stored.size,
      sha256: stored.sha256,
      blobId: stored.blobId,
      extractionStatus: extracted.status,
      extractedChars: extracted.text.length,
      detail: extracted.detail,
      createdAt: new Date(),
      ...scope,
    };

    return write(async (tx) => {
      const created = await KnowledgeAttachmentRepository.create(tx, attachment);
      if (chunks.length > 0) {
        await KnowledgeChunkRepository.createForDocument(tx, { documentId, chunks });
      }
      await KnowledgeDocumentRepository.update(tx, documentId, { updatedAt: new Date() });
      await AuditService.record({
        tx,
        kind: 'update',
        targetId: documentId,
        targetKind: 'knowledge_document',
        actor: input.actor,
        payload: {
          attachmentAdded: created.id,
          filename: created.filename,
          mimeType: created.mimeType,
          extraction: extracted.status,
          chunkCount: chunks.length,
        },
      });
      return created;
    });
  }

  async function deleteAttachment(
    attachmentId: string,
    opts: { actor?: string } = {},
  ): Promise<void> {
    const { blobStore } = requireAttachmentDeps();
    const attachment = await read((tx) => KnowledgeAttachmentRepository.getById(tx, attachmentId));
    if (!attachment) throw notFound(`attachment ${attachmentId}`);

    await write(async (tx) => {
      await KnowledgeChunkRepository.deleteForAttachment(tx, attachmentId);
      await KnowledgeAttachmentRepository.delete(tx, attachmentId);
      await KnowledgeDocumentRepository.update(tx, attachment.documentId, {
        updatedAt: new Date(),
      });
      await AuditService.record({
        tx,
        kind: 'update',
        targetId: attachment.documentId,
        targetKind: 'knowledge_document',
        actor: opts.actor,
        payload: { attachmentRemoved: attachmentId, filename: attachment.filename },
      });
    });
    await blobStore.delete(attachment.blobId);
  }

  // Remove every attachment of a document (nodes + blobs). The caller deletes
  // the derived chunks separately. Used by the document hard-purge path.
  async function purgeAttachmentBlobs(documentId: string): Promise<void> {
    const blobStore = deps.blobStore;
    if (!blobStore) return;
    const attachments = await read((tx) =>
      KnowledgeAttachmentRepository.listByDocument(tx, documentId),
    );
    await write((tx) => KnowledgeAttachmentRepository.deleteForDocument(tx, documentId));
    await Promise.all(attachments.map((a) => blobStore.delete(a.blobId)));
  }

  async function getAttachment(attachmentId: string): Promise<KnowledgeAttachment | null> {
    return read((tx) => KnowledgeAttachmentRepository.getById(tx, attachmentId));
  }

  async function getAttachmentByBlob(blobId: string): Promise<KnowledgeAttachment | null> {
    return read((tx) => KnowledgeAttachmentRepository.getByBlobId(tx, blobId));
  }

  function openBlob(blobId: string) {
    return requireAttachmentDeps().blobStore.getStream(blobId);
  }

  async function softDelete(id: string, opts: { actor?: string } = {}): Promise<void> {
    // Pre-read for the vault tombstone: the ref needs the document's scope
    // to resolve its vault path.
    const existing = await read((tx) => KnowledgeDocumentRepository.get(tx, id));
    const at = new Date();
    await write(async (tx) => {
      await KnowledgeDocumentRepository.softDelete(tx, id, at);
      await AuditService.record({
        tx,
        kind: 'soft_delete',
        targetId: id,
        targetKind: 'knowledge_document',
        actor: opts.actor,
      });
    });
    if (existing) await vaultTombstone(existing, at);
  }

  return {
    ingest,
    update,
    softDelete,
    getWithAttachments,
    addAttachment,
    deleteAttachment,
    purgeAttachmentBlobs,
    getAttachment,
    getAttachmentByBlob,
    openBlob,
  };
}

export type KnowledgeIngestionService = ReturnType<typeof createKnowledgeIngestionService>;
