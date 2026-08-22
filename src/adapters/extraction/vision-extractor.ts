import type AnthropicNS from '@anthropic-ai/sdk';
import { prepareImageForVision } from './image-preprocess.ts';
import { deferred } from './service.ts';
import type { ExtractionInput, ExtractionResult, Extractor } from './types.ts';

/** One place to send an image, with its per-provider credentials. */
export interface VisionTargetConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  anthropicApiKey?: string;
}

export interface VisionConfig {
  /** Tried in order: the primary first, then any fallback. A target's output
   *  must pass checkVisionOutput before it is stored; a flunk or a thrown call
   *  advances to the next target instead of failing the attachment. */
  targets: VisionTargetConfig[];
  /** Ceiling for a single model call, shared by every target. A local vision
   *  model can take minutes; a hosted fallback finishing in seconds is
   *  unaffected by the generous ceiling. */
  timeoutMs: number;
  /** Longest edge, in px, an image is downscaled to before OCR. */
  maxDim: number;
  /** JPEG quality used when a downscale re-encodes. */
  jpegQuality: number;
  /** Output ceiling for one OCR call. A dense screenshot needs several thousand
   *  tokens; too low and the transcription stops mid-sentence. */
  maxTokens: number;
}

// The marker and sentinel are what checkVisionOutput looks for, so they live
// next to the prompt that demands them: change one and the other must follow.
export const DESCRIPTION_MARKER = 'DESCRIPTION:';
export const NO_TEXT_SENTINEL = 'NO TEXT';

// Transcription first, description last. The order is deliberate: a small local
// model given "reply with two labelled sections" produces the section headings
// and stops (observed live: a legible table screenshot came back as 9 tokens of
// headings with finish_reason=stop, stored as 'done'), while "transcribe
// everything, then describe" makes the same model emit the full table. The
// trailing marker also makes conformance checkable, and the sentinel keeps "no
// text in this image" distinguishable from "model gave up".
const PROMPT = [
  'Transcribe every piece of text visible in this image, verbatim and complete.',
  'Preserve the line structure; render tables as markdown tables.',
  `If the image contains no visible text, write exactly ${NO_TEXT_SENTINEL} instead of a transcription.`,
  `Then, as the final line, write "${DESCRIPTION_MARKER} " followed by one short line describing the image.`,
].join('\n');

/** What a provider gave back: the text, plus whether the model stopped because
 *  it hit the output ceiling rather than because it was finished. */
export interface VisionResponse {
  text: string;
  truncated: boolean;
}

/**
 * Shape check on a completed (non-truncated) response: null when it conforms
 * to PROMPT's contract, otherwise a human-readable reason for the flunk.
 *
 * This exists because a model can give up without erroring: the observed
 * failure returned a handful of heading tokens with a clean stop, and storing
 * that as 'done' made a junk reading indistinguishable from a real one. The
 * rules are deliberately about shape, not length — a photo of a single word
 * legitimately transcribes to two short lines — and use no token-usage
 * signals, which the Anthropic path does not return.
 */
export function checkVisionOutput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty response';
  const lines = trimmed.split('\n');
  // Search from the end: the marker is specified as the final line, and a
  // transcription may legitimately quote the word earlier in the image's text.
  const markerIndex = lines.findLastIndex(isMarkerLine);
  if (markerIndex === -1) return `missing ${DESCRIPTION_MARKER} marker`;
  const body = lines.slice(0, markerIndex).join('\n').trim();
  if (body.length === 0) return `no transcription and no ${NO_TEXT_SENTINEL} sentinel`;
  return null;
}

/**
 * Does this line carry the description marker?
 *
 * Matched on the line's letters, not its decoration: the prompt asks for
 * markdown, and models answer in it — `**DESCRIPTION:**`, `### DESCRIPTION:`,
 * `- Description:` are all the marker doing its job. An exact case-sensitive
 * prefix test would flunk a complete, correct transcription over a pair of
 * asterisks and, with no fallback configured, discard it entirely.
 */
function isMarkerLine(line: string): boolean {
  return line
    .trim()
    .replace(/^[#>*_`\-\s]+/, '')
    .toUpperCase()
    .startsWith(DESCRIPTION_MARKER);
}

/** How a target names itself in an extraction's `detail`. One definition
 *  because the string is contractual: it is what a reader sees recorded against
 *  the attachment, and what the fallback outcomes are listed by. */
function targetLabel(target: { provider: string; model: string }): string {
  return `${target.provider}:${target.model}`;
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
  const source = targetLabel(meta);
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

/** One model call against one target. Injectable so tests can script per-target
 *  responses without a provider SDK — the same seam pdf-extractor exposes as
 *  `ocrPage`. */
export type CallVisionProvider = (
  target: VisionTargetConfig,
  mime: string,
  b64: string,
) => Promise<VisionResponse>;

/**
 * Why this target's reading must not be stored, or null to accept it.
 *
 * The quality guard applies to completed responses only: the marker is the
 * final line, so output clipped at max_tokens can never contain it. A
 * truncated-but-nonempty reading is therefore accepted (mapVisionResponse
 * records it as 'truncated') — the next target shares maxTokens and would just
 * truncate the same way. Truncated with nothing to show for it is a reading of
 * nothing, which is worth spending another target on.
 */
function unusableReason(response: VisionResponse, label: string): string | null {
  if (response.truncated) {
    return response.text.trim().length === 0
      ? `${label} produced no text before hitting max_tokens`
      : null;
  }
  const flunk = checkVisionOutput(response.text);
  return flunk === null ? null : `${label} flunked quality guard: ${flunk}`;
}

// Vision OCR/description for image attachments. Produces searchable text via
// the configured multimodal LLM(s). Construct only when a provider is
// available; callers pass `null` to disable (→ images are stored but not
// text-extracted).
export function createVisionExtractor(
  config: VisionConfig,
  callProvider: CallVisionProvider = (target, mime, b64) =>
    target.provider === 'anthropic'
      ? viaAnthropic(target, config, mime, b64)
      : viaOpenAI(target, config, mime, b64),
): Extractor {
  return {
    supports: supportsImage,
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      // Every image needs a model call, so this extractor is always the slow
      // path. Say so rather than making the upload request wait on it.
      if (!input.allowSlow) return deferred('vision extraction');

      // Downscale first: vision prefill cost scales with pixel count, and a
      // full-size phone photo costs minutes of GPU for no accuracy gain over the
      // 1024px version. This also normalises whatever it re-encodes to JPEG,
      // which every provider accepts. One downscale serves every target.
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

      const b64 = prepared.data.toString('base64');
      // Why a thrown call advances rather than fails: to the attachment it
      // makes no difference whether the local model was down or produced junk —
      // either way the fallback is the next best reading. Only the last
      // target's outcome is terminal.
      const outcomes: string[] = [];
      for (const target of config.targets) {
        const label = targetLabel(target);
        let response: VisionResponse;
        try {
          response = await callProvider(target, prepared.mimeType, b64);
        } catch (err) {
          outcomes.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const unusable = unusableReason(response, label);
        if (unusable) {
          outcomes.push(unusable);
          continue;
        }
        const result = mapVisionResponse(response, target);
        return outcomes.length === 0
          ? result
          : { ...result, detail: `${result.detail} (fallback after ${outcomes.join('; ')})` };
      }
      return {
        status: 'failed',
        text: '',
        detail: `all vision targets failed — ${outcomes.join('; ')}`,
      };
    },
  };
}

/** The per-call ceilings every target shares: credentials and model come from
 *  the target, budget from the one VisionConfig. */
type CallLimits = { timeoutMs: number; maxTokens: number };

async function viaOpenAI(
  target: VisionTargetConfig,
  limits: CallLimits,
  mime: string,
  b64: string,
): Promise<VisionResponse> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey: target.openaiApiKey ?? 'unused',
    baseURL: target.openaiBaseUrl,
    timeout: limits.timeoutMs,
    // The SDK retries twice by default, which would triple an already-slow
    // vision call instead of surfacing the timeout as a 'failed' with a reason.
    maxRetries: 0,
  });
  const res = await client.chat.completions.create({
    model: target.model,
    max_tokens: limits.maxTokens,
    // OCR wants the most likely reading, not a creative one — sampling at the
    // default temperature made a small local model wander off the transcription.
    temperature: 0,
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
  target: VisionTargetConfig,
  limits: CallLimits,
  mime: string,
  b64: string,
): Promise<VisionResponse> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: target.anthropicApiKey ?? 'unused',
    timeout: limits.timeoutMs,
    maxRetries: 0,
  });
  const res = await client.messages.create({
    model: target.model,
    max_tokens: limits.maxTokens,
    temperature: 0,
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
