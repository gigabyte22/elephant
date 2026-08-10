import type AnthropicNS from '@anthropic-ai/sdk';
import { prepareImageForVision } from './image-preprocess.ts';
import { deferred } from './service.ts';
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
  /** Output ceiling for one OCR call. A dense screenshot needs several thousand
   *  tokens; too low and the transcription stops mid-sentence. */
  maxTokens: number;
}

// The two halves are labelled because they are different kinds of claim: the
// OCR block is what the image says, the description is what the model thinks it
// depicts. A reader — human or agent — pulling this text out of recall should
// not have to guess which one they are quoting.
const PROMPT = [
  'Read this image and reply with exactly two labelled sections and nothing else:',
  'OCR:',
  'the text visible in the image, transcribed verbatim; leave this section empty if there is none',
  'DESCRIPTION:',
  'one short line describing the image',
].join('\n');

/** What a provider gave back: the text, plus whether the model stopped because
 *  it hit the output ceiling rather than because it was finished. */
export interface VisionResponse {
  text: string;
  truncated: boolean;
}

/**
 * The truncation branch is the point of this helper: a model that ran out of
 * output tokens returns a transcription that stops mid-word, and storing that
 * as 'done' makes a half-read screenshot indistinguishable from a fully-read
 * one. The partial text is still worth indexing — it just has to say so. The
 * LLM adapters make the same check (see the max_tokens guards in
 * ../llm/anthropic.ts), where an incomplete JSON body is fatal rather than
 * merely lossy.
 */
export function mapVisionResponse(
  response: VisionResponse,
  meta: { provider: string; model: string },
): ExtractionResult {
  const text = response.text.trim();
  const source = `${meta.provider}:${meta.model}`;
  if (text.length === 0) {
    return {
      status: 'empty',
      text: '',
      detail: response.truncated
        ? `${source} — produced no text before hitting max_tokens`
        : source,
    };
  }
  if (response.truncated) {
    return {
      status: 'truncated',
      text,
      detail: `${source} — output stopped at max_tokens; transcription is incomplete`,
      derivation: 'model',
    };
  }
  return { status: 'done', text, detail: source, derivation: 'model' };
}

/** The MIME types this extractor claims. Exported so the factory can register a
 *  disabled stand-in over exactly the same set when no provider is configured,
 *  and decide from the same predicate which uploads to defer. */
export function supportsImage(mime: string): boolean {
  return mime.startsWith('image/');
}

// Vision OCR/description for image attachments. Produces searchable text via
// the configured multimodal LLM. Construct only when a provider is available;
// callers pass `null` to disable (→ images are stored but not text-extracted).
export function createVisionExtractor(config: VisionConfig): Extractor {
  return {
    supports: supportsImage,
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      // Every image needs a model call, so this extractor is always the slow
      // path. Say so rather than making the upload request wait on it.
      if (!input.allowSlow) return deferred('vision extraction');

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
        const response =
          config.provider === 'anthropic'
            ? await viaAnthropic(config, prepared.mimeType, b64)
            : await viaOpenAI(config, prepared.mimeType, b64);
        return mapVisionResponse(response, config);
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

async function viaOpenAI(config: VisionConfig, mime: string, b64: string): Promise<VisionResponse> {
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
    max_tokens: config.maxTokens,
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
  return {
    text: res.choices[0]?.message?.content ?? '',
    truncated: res.choices[0]?.finish_reason === 'length',
  };
}

async function viaAnthropic(
  config: VisionConfig,
  mime: string,
  b64: string,
): Promise<VisionResponse> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: config.anthropicApiKey ?? 'unused',
    timeout: config.timeoutMs,
    maxRetries: 0,
  });
  const res = await client.messages.create({
    model: config.model,
    max_tokens: config.maxTokens,
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
  return {
    text: res.content
      .filter((b): b is AnthropicNS.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n'),
    truncated: res.stop_reason === 'max_tokens',
  };
}
