import { deferred } from './service.ts';
import type { ExtractionInput, ExtractionResult, Extractor } from './types.ts';

export interface AudioConfig {
  model: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  /** Ceiling for a single transcription. Long recordings are slow on local Whisper. */
  timeoutMs: number;
}

/** The MIME types this extractor claims. Exported so the factory can register a
 *  disabled stand-in over exactly the same set when no provider is configured,
 *  and decide from the same predicate which uploads to defer. */
export function supportsAudio(mime: string): boolean {
  return mime.startsWith('audio/') || mime === 'video/webm' || mime === 'video/mp4';
}

// Speech-to-text for audio attachments via an OpenAI-compatible transcription
// endpoint (Whisper). Construct only when an API key is available; callers pass
// `null` to disable (→ audio is stored but not transcribed).
export function createAudioExtractor(config: AudioConfig): Extractor {
  return {
    supports: supportsAudio,
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      // Transcription is minutes for a long recording; never inline.
      if (!input.allowSlow) return deferred('transcription');

      try {
        const { default: OpenAI, toFile } = await import('openai');
        const client = new OpenAI({
          apiKey: config.openaiApiKey ?? 'unused',
          baseURL: config.openaiBaseUrl,
          timeout: config.timeoutMs,
          maxRetries: 0,
        });
        const file = await toFile(input.data, input.filename || 'audio', { type: input.mimeType });
        const res = await client.audio.transcriptions.create({ model: config.model, file });
        const text = (res.text ?? '').trim();
        return text.length > 0
          ? { status: 'done', text, detail: `openai:${config.model}`, derivation: 'model' }
          : { status: 'empty', text: '' };
      } catch (err) {
        return {
          status: 'failed',
          text: '',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
