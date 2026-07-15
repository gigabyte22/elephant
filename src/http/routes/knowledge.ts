import { z } from 'zod';
import { read, write } from '../../config/neo4j.ts';
import type { Container } from '../../index.ts';
import { toWireKnowledgeAttachment, toWireKnowledgeDocument } from '../../models/wire.ts';
import { KnowledgeChunkRepository } from '../../repositories/KnowledgeChunkRepository.ts';
import { KnowledgeDocumentRepository } from '../../repositories/KnowledgeDocumentRepository.ts';
import { notFound } from '../errors.ts';
import type { App } from '../types.ts';
import {
  WireKnowledgeAttachmentSchema,
  WireKnowledgeDocumentSchema,
  okEnvelope,
} from '../wire-schemas.ts';

const ScopeBody = z.object({
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
});

const CreateBody = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  source: z.string().min(1),
  sourceUri: z.string().url().optional(),
  content: z.string().min(1),
  summary: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  scope: ScopeBody.optional(),
  actor: z.string().optional(),
});

const UpdateBody = z
  .object({
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    summary: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    actor: z.string().optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== 'actor'), {
    message: 'at least one field to update is required',
  });

const ListQuery = z.object({
  projectId: z.string().optional(),
  userId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export function registerKnowledgeRoutes(app: App, container: Container): void {
  app.route({
    method: 'POST',
    url: '/knowledge/documents',
    schema: {
      body: CreateBody,
      response: { 200: okEnvelope(WireKnowledgeDocumentSchema) },
    },
    handler: async (req) => {
      const doc = await container.knowledge.ingest(req.body);
      return { ok: true as const, data: toWireKnowledgeDocument(doc) };
    },
  });

  app.route({
    method: 'GET',
    url: '/knowledge/documents/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      response: { 200: okEnvelope(WireKnowledgeDocumentSchema) },
    },
    handler: async (req) => {
      const result = await container.knowledge.getWithAttachments(req.params.id);
      if (!result) throw notFound(`knowledge document ${req.params.id}`);
      return {
        ok: true as const,
        data: toWireKnowledgeDocument(result.document, result.attachments, result.attachmentTexts),
      };
    },
  });

  app.route({
    method: 'PUT',
    url: '/knowledge/documents/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: UpdateBody,
      response: { 200: okEnvelope(WireKnowledgeDocumentSchema) },
    },
    handler: async (req) => {
      const doc = await container.knowledge.update(req.params.id, req.body);
      return { ok: true as const, data: toWireKnowledgeDocument(doc) };
    },
  });

  app.route({
    method: 'GET',
    url: '/knowledge/documents',
    schema: {
      querystring: ListQuery,
      response: { 200: okEnvelope(z.array(WireKnowledgeDocumentSchema)) },
    },
    handler: async (req) => {
      const docs = await read((tx) =>
        KnowledgeDocumentRepository.list(tx, {
          scope: {
            projectId: req.query.projectId,
            userId: req.query.userId,
            projectScope: req.query.projectId ? 'filter' : 'none',
            userScope: req.query.userId ? 'filter' : 'none',
          },
          limit: req.query.limit,
        }),
      );
      return { ok: true as const, data: docs.map((d) => toWireKnowledgeDocument(d)) };
    },
  });

  app.route({
    method: 'DELETE',
    url: '/knowledge/documents/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: z.object({ purge: z.enum(['true', 'false']).optional() }),
      response: {
        200: okEnvelope(z.object({ deleted: z.literal(true), chunksDeleted: z.number() })),
      },
    },
    handler: async (req) => {
      const existing = await read((tx) => KnowledgeDocumentRepository.get(tx, req.params.id));
      if (!existing) throw notFound(`knowledge document ${req.params.id}`);
      const purge = req.query.purge === 'true';
      let chunksDeleted = 0;
      if (purge) {
        // Remove attachment nodes + their blobs, then all chunks (body + attachment).
        await container.knowledge.purgeAttachmentBlobs(req.params.id);
        chunksDeleted = await write((tx) =>
          KnowledgeChunkRepository.deleteForDocument(tx, req.params.id),
        );
      }
      await container.knowledge.softDelete(req.params.id, { actor: undefined });
      return {
        ok: true as const,
        data: { deleted: true as const, chunksDeleted },
      };
    },
  });

  // ── Attachments ──

  const AttachmentBody = z.object({
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    dataBase64: z.string().min(1),
    actor: z.string().optional(),
  });

  app.route({
    method: 'POST',
    url: '/knowledge/documents/:id/attachments',
    // Base64 file bytes inflate ~1.37×; allow headroom over the raw cap.
    bodyLimit: Math.ceil(container.env.KNOWLEDGE_MAX_ATTACHMENT_BYTES * 1.5) + 65_536,
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: AttachmentBody,
      response: { 200: okEnvelope(WireKnowledgeAttachmentSchema) },
    },
    handler: async (req) => {
      const att = await container.knowledge.addAttachment(req.params.id, req.body);
      return { ok: true as const, data: toWireKnowledgeAttachment(att) };
    },
  });

  app.route({
    method: 'DELETE',
    url: '/knowledge/documents/:id/attachments/:attachmentId',
    schema: {
      params: z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() }),
      response: { 200: okEnvelope(z.object({ deleted: z.literal(true) })) },
    },
    handler: async (req) => {
      await container.knowledge.deleteAttachment(req.params.attachmentId);
      return { ok: true as const, data: { deleted: true as const } };
    },
  });

  // Raw blob download. Returns the binary directly (not the JSON envelope) with
  // the stored content type so browsers/players can render it inline.
  app.route({
    method: 'GET',
    url: '/knowledge/attachments/:blobId',
    schema: { params: z.object({ blobId: z.string().min(1) }) },
    handler: async (req, reply) => {
      const att = await container.knowledge.getAttachmentByBlob(req.params.blobId);
      if (!att) throw notFound(`attachment blob ${req.params.blobId}`);
      const stream = await container.knowledge.openBlob(att.blobId);
      void reply
        .header('Content-Type', att.mimeType)
        .header('Content-Length', String(att.size))
        .header('Content-Disposition', `inline; filename="${att.filename.replace(/["\\]/g, '_')}"`);
      return reply.send(stream);
    },
  });
}
