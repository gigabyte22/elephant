import { z } from 'zod';
import type { Container } from '../../index.ts';
import { EpisodeParticipantSchema, normalizeParticipantLabel } from '../../models/types.ts';
import type { App } from '../types.ts';
import { okEnvelope } from '../wire-schemas.ts';

// Provenance only: a small map, not a side-channel for content.
const MAX_METADATA_ENTRIES = 16;

const Body = z.object({
  id: z.string().uuid().optional(),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  rawTranscript: z.string().min(1),
  summary: z.string().optional(),
  timestamp: z.coerce.date().optional(),
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  // Provenance: how this episode came to exist (human chat vs autonomous run
  // vs content ingestion). Optional — old clients simply omit it.
  origin: z.enum(['user', 'cron', 'event', 'system', 'ingest']).optional(),
  // Declared human speakers for multi-party transcripts (turns labeled
  // `USER(<label>):`). Omitted = single-user legacy behavior. Labels must be
  // unique case-insensitively — extraction matches them case-insensitively,
  // so duplicates would make attribution ambiguous.
  participants: z
    .array(EpisodeParticipantSchema)
    .max(32)
    .superRefine((participants, ctx) => {
      const seen = new Set<string>();
      for (const [i, p] of participants.entries()) {
        const norm = normalizeParticipantLabel(p.label);
        if (seen.has(norm)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'label'],
            message: `duplicate participant label (case-insensitive): ${p.label}`,
          });
        }
        seen.add(norm);
      }
    })
    .optional(),
  // Isolated projects opt out of cross-scope dedup against the personal bucket.
  isolated: z.boolean().optional(),
  // Free-form provenance: where this episode came from in the caller's own
  // world (room id, turn id, upstream session id, ...). Stored as an opaque
  // JSON blob and never indexed, searched, recalled or scored — it exists so
  // an operator can trace an episode back to its source. Bounded so it stays
  // provenance rather than a second payload.
  metadata: z
    .record(z.string().min(1).max(64), z.string().max(512))
    .refine((m) => Object.keys(m).length <= MAX_METADATA_ENTRIES, {
      message: `metadata accepts at most ${MAX_METADATA_ENTRIES} entries`,
    })
    .optional(),
});

export function registerEpisodesRoute(app: App, container: Container): void {
  app.route({
    method: 'POST',
    url: '/episodes',
    schema: {
      body: Body,
      response: { 200: okEnvelope(z.object({ episodeId: z.string().uuid() })) },
    },
    handler: async (req) => {
      const ep = await container.ingestion.ingestEpisode(req.body);
      return { ok: true as const, data: { episodeId: ep.id } };
    },
  });
}
