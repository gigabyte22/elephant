import { Cron } from 'croner';
import type { Container } from '../index.ts';
import type { SchedulerHandle } from './DreamScheduler.ts';

// Drains attachments parked as 'pending' by the upload path.
//
// Why this exists at all: a vision or transcription call takes seconds to
// minutes, while dobby's memory client aborts an upload after 30s and retries.
// Running extraction inline therefore returned an error to the user *and* left
// one extra attachment row per retry. Uploads now return as soon as the bytes
// are stored, and the slow part happens here.
//
// One attachment per tick, with croner's `protect` preventing overlap: the
// vision model and elephant's own embedding model share a single GPU, so a
// second concurrent extraction would not go faster — it would stall ingestion
// for everything else.
export function startAttachmentExtractionWorker(container: Container): SchedulerHandle {
  const pattern = container.env.KNOWLEDGE_EXTRACTION_CRON;
  const job = new Cron(pattern, { protect: true }, async () => {
    const pending = await container.knowledge.listPendingAttachments(1).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[extraction-worker] could not list pending attachments', err);
      return [];
    });
    const next = pending[0];
    if (!next) return;

    try {
      const started = Date.now();
      const updated = await container.knowledge.reextractAttachment(next.id, {
        actor: 'attachment-extraction-worker',
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      // eslint-disable-next-line no-console
      console.log(
        `[extraction-worker] ${next.filename} (${next.mimeType}) -> ${updated.extractionStatus}` +
          ` ${updated.extractedChars} chars in ${seconds}s` +
          (updated.detail ? ` — ${updated.detail}` : ''),
      );
    } catch (err) {
      // Extractors map their own errors to a 'failed' result, so reaching here
      // means something structural broke (missing blob, embedder down). Record
      // it rather than leaving the row 'pending' — otherwise this same
      // attachment is retried every tick forever, starving the queue behind it.
      // 'failed' is still recoverable: the backfill script re-runs those.
      const detail = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[extraction-worker] ${next.filename} failed structurally: ${detail}`);
      await container.knowledge.markAttachmentFailed(next.id, detail).catch((markErr) =>
        // eslint-disable-next-line no-console
        console.error('[extraction-worker] could not record failure', markErr),
      );
    }
  });
  return {
    pattern,
    stop: () => job.stop(),
  };
}
