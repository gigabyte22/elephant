import type { ExtractionInput, ExtractionResult, Extractor } from './types.ts';

export interface VisionConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  anthropicApiKey?: string;
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
      try {
        const b64 = input.data.toString('base64');
        const text =
          config.provider === 'anthropic'
            ? await viaAnthropic(config, input.mimeType, b64)
            : await viaOpenAI(config, input.mimeType, b64);
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
  const client = new Anthropic({ apiKey: config.anthropicApiKey ?? 'unused' });
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
              media_type: mime as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
              data: b64,
            },
          },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  return res.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
