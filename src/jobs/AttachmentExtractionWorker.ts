import { Cron } from 'croner';
import type { Container } from '../index.ts';
import type { SchedulerHandle } from './DreamScheduler.ts';

// What became of a structurally failed attachment, for the log line. A null
// outcome means recording the failure itself failed, so nothing was stamped and
// the row is still due — worth saying, because it reads otherwise as a retry
// that was scheduled.
function describeDisposition(
  outcome: { attempts: number; deadLettered: boolean } | null,
  maxAttempts: number,
): string {
  if (!outcome) return 'failure not recorded, re-claimed next tick';
  if (outcome.deadLettered) return `dead-lettered after ${outcome.attempts} attempt(s)`;
  return `attempt ${outcome.attempts}/${maxAttempts}, will retry`;
}

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
      // means something structural broke (missing blob, embedder down). Stamp
      // the attempt so the row backs off instead of being re-claimed every tick
      // and starving the queue behind it — and so a provider that is down for
      // five minutes does not permanently strand everything uploaded during it.
      // Only once the attempts are spent is it dead-lettered to 'failed', which
      // the backfill script re-runs.
      const detail = err instanceof Error ? err.message : String(err);
      const outcome = await container.knowledge
        .markAttachmentFailed(next.id, detail)
        .catch((markErr) => {
          // eslint-disable-next-line no-console
          console.error('[extraction-worker] could not record failure', markErr);
          return null;
        });
      const disposition = describeDisposition(
        outcome,
        container.env.KNOWLEDGE_EXTRACTION_MAX_ATTEMPTS,
      );
      // eslint-disable-next-line no-console
      console.error(
        `[extraction-worker] ${next.filename} failed structurally (${disposition}): ${detail}`,
      );
    }
  });
  return {
    pattern,
    stop: () => job.stop(),
  };
}
