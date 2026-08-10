import type AnthropicNS from '@anthropic-ai/sdk';
import { prepareImageForVision } from './image-preprocess.ts';
import type { ExtractionInput, ExtractionResult, Extractor } from './types.ts';

export interface VisionConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  anthropicApiKey?: string;
  /** Ceiling for a single model call. A local vision model can take minutes. */
  timeoutMs: number;
  /** Longest edge, in px, an image is downscaled to before OCR. */
  maxDim: number;
  /** JPEG quality used when a downscale re-encodes. */
  jpegQuality: number;
}

const PROMPT =
  'Transcribe verbatim any text visible in this image (OCR). Then add one short line describing the image. Output plain text only — no preamble.';

// Vision OCR/description for image attachments. Produces searchable text via
// the configured multimodal LLM. Construct only when a provider is available;
// callers pass `null` to disable (→ images are stored but not text-extracted).
export function createVisionExtractor(config: VisionConfig): Extractor {
  return {
    supports(mime: string): boolean {
      return mime.startsWith('image/');
    },
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      // Downscale first: vision prefill cost scales with pixel count, and a
      // full-size phone photo costs minutes of GPU for no accuracy gain over the
      // 1024px version. This also normalises whatever it re-encodes to JPEG,
      // which every provider accepts.
      let prepared: { data: Buffer; mimeType: string } | null;
      try {
        prepared = await prepareImageForVision(input.data, input.mimeType, {
          maxDim: config.maxDim,
          quality: config.jpegQuality,
        });
      } catch (err) {
        return {
          status: 'failed',
          text: '',
          detail: `image preprocessing failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // A format neither this decoder nor any provider can read. Say so rather
      // than spending a model call on a guaranteed 400.
      if (!prepared) {
        return {
          status: 'skipped',
          text: '',
          detail: `unreadable image format: ${input.mimeType}`,
        };
      }

      try {
        const b64 = prepared.data.toString('base64');
        const text =
          config.provider === 'anthropic'
            ? await viaAnthropic(config, prepared.mimeType, b64)
            : await viaOpenAI(config, prepared.mimeType, b64);
        const trimmed = text.trim();
        return trimmed.length > 0
          ? { status: 'done', text: trimmed, detail: `${config.provider}:${config.model}` }
          : { status: 'empty', text: '', detail: config.provider };
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

async function viaOpenAI(config: VisionConfig, mime: string, b64: string): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey: config.openaiApiKey ?? 'unused',
    baseURL: config.openaiBaseUrl,
    timeout: config.timeoutMs,
    // The SDK retries twice by default, which would triple an already-slow
    // vision call instead of surfacing the timeout as a 'failed' with a reason.
    maxRetries: 0,
  });
  const res = await client.chat.completions.create({
    model: config.model,
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
  });
  return res.choices[0]?.message?.content ?? '';
}

async function viaAnthropic(config: VisionConfig, mime: string, b64: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: config.anthropicApiKey ?? 'unused',
    timeout: config.timeoutMs,
    maxRetries: 0,
  });
  const res = await client.messages.create({
    model: config.model,
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              // Safe cast: prepareImageForVision only ever yields a media type
              // in this set — anything else it returns as null.
              media_type: mime as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
              data: b64,
            },
          },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  // Narrow with the SDK's own type, not a structural literal: TextBlock grows
  // required fields across releases (0.115 added `citations`), and a hand-written
  // shape stops being assignable the moment it does.
  return res.content
    .filter((b): b is AnthropicNS.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
