import type { Env } from '../config/env.ts';
import { createOllamaEmbeddingAdapter } from './embeddings/ollama.ts';
import { createOpenAIEmbeddingAdapter } from './embeddings/openai.ts';
import type { EmbeddingAdapter } from './embeddings/types.ts';
import { createVoyageEmbeddingAdapter } from './embeddings/voyage.ts';
import { createAudioExtractor, supportsAudio } from './extraction/audio-extractor.ts';
import { createPdfExtractor } from './extraction/pdf-extractor.ts';
import { createDisabledExtractor, createExtractionService } from './extraction/service.ts';
import { createTextExtractor } from './extraction/text-extractor.ts';
import type { ExtractionService, Extractor } from './extraction/types.ts';
import { createVisionExtractor, supportsImage } from './extraction/vision-extractor.ts';
import { createAnthropicLLMAdapter } from './llm/anthropic.ts';
import { createLlamaCppLLMAdapter } from './llm/llamacpp.ts';
import { createOpenAILLMAdapter } from './llm/openai.ts';
import type { LLMAdapter } from './llm/types.ts';
import { createFsBlobStore } from './storage/fs-blob-store.ts';
import type { BlobStore } from './storage/types.ts';
import { createFsVaultWriter } from './vault/fs-vault-writer.ts';
import type { VaultWriter } from './vault/types.ts';
import { Neo4jWorkingStateAdapter } from './working-state/neo4j.ts';
import type { WorkingStateAdapter } from './working-state/types.ts';

export function buildLLMAdapter(env: Env): LLMAdapter {
  switch (env.MEMORY_LLM_PROVIDER) {
    case 'anthropic':
      return createAnthropicLLMAdapter({
        // env validation already enforced this is set
        apiKey: env.ANTHROPIC_API_KEY!,
        extractionModel: env.ANTHROPIC_EXTRACTION_MODEL,
        dreamingModel: env.ANTHROPIC_DREAMING_MODEL,
      });
    case 'openai':
      return createOpenAILLMAdapter({
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_BASE_URL,
        model: env.OPENAI_EXTRACTION_MODEL,
      });
    case 'llamacpp':
      return createLlamaCppLLMAdapter({
        baseURL: env.LLAMACPP_BASE_URL!,
        model: env.LLAMACPP_MODEL,
      });
  }
}

export function buildEmbeddingAdapter(env: Env): EmbeddingAdapter {
  switch (env.MEMORY_EMBED_PROVIDER) {
    case 'openai':
      return createOpenAIEmbeddingAdapter({
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_BASE_URL,
        model: env.OPENAI_EMBED_MODEL,
        dim: env.EMBED_DIM,
      });
    case 'voyage':
      // Voyage requires an API key; surface a clearer error than the generic env validator.
      if (!env.OPENAI_API_KEY && !process.env.VOYAGE_API_KEY) {
        throw new Error('VOYAGE_API_KEY required when MEMORY_EMBED_PROVIDER=voyage');
      }
      return createVoyageEmbeddingAdapter({
        apiKey: process.env.VOYAGE_API_KEY ?? '',
        model: 'voyage-3',
        dim: env.EMBED_DIM,
      });
    case 'ollama':
      return createOllamaEmbeddingAdapter({
        baseURL: env.OLLAMA_BASE_URL!,
        model: env.OLLAMA_EMBED_MODEL,
        dim: env.EMBED_DIM,
      });
  }
}

/**
 * Build the WorkingState adapter selected by env.WORKING_STATE_BACKEND.
 *
 * Redis client is loaded dynamically so callers running with the default
 * Neo4j backend never need ioredis on their classpath.
 */
export async function buildWorkingStateAdapter(env: Env): Promise<WorkingStateAdapter> {
  if (env.WORKING_STATE_BACKEND === 'redis') {
    const ioredis = await import('ioredis');
    const RedisCtor = (ioredis as unknown as { Redis: new (url: string) => unknown }).Redis;
    const { RedisWorkingStateAdapter } = await import('./working-state/redis.ts');
    const client = new RedisCtor(env.REDIS_URL!) as unknown as import('ioredis').Redis;
    return new RedisWorkingStateAdapter(client);
  }
  return new Neo4jWorkingStateAdapter();
}

export function buildBlobStore(env: Env): BlobStore {
  return createFsBlobStore(env.KNOWLEDGE_BLOB_DIR);
}

export function buildVaultWriter(env: Env): VaultWriter | undefined {
  return env.OKF_ENABLED ? createFsVaultWriter(env.OKF_DIR) : undefined;
}

// Credentials for OCR and transcription.
//
// Dedicated KNOWLEDGE_VISION_* / KNOWLEDGE_TRANSCRIBE_* values are the opt-in:
// setting one says "send attachments to this endpoint". The shared OPENAI_* pair
// is a fallback that only applies once a provider has been named explicitly,
// because those keys are set for the LLM and embedding adapters and carry no
// statement about uploading a user's images to anyone.
export interface Creds {
  key?: string;
  baseUrl?: string;
}

/** An OpenAI-compatible endpoint is usable once it has either a key or a URL —
 *  a local server needs no key, a hosted one needs no URL. `shared` is the
 *  OPENAI_* pair, passed only when the operator opted into spending it here. */
function pickCreds(dedicated: Creds, shared: Creds | null): Creds | null {
  const key = dedicated.key || shared?.key;
  const baseUrl = dedicated.baseUrl || shared?.baseUrl;
  return key || baseUrl ? { key, baseUrl } : null;
}

function sharedOpenAICreds(env: Env): Creds {
  return { key: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL };
}

/** Where images are sent for OCR, or null when the capability is off. Only the
 *  OpenAI-compatible path carries credentials; Anthropic uses ANTHROPIC_API_KEY,
 *  which `buildExtractionService` passes separately. */
export type VisionTarget = Creds & { provider: 'anthropic' | 'openai' };

/**
 * Resolve the vision capability.
 *
 * 'auto' means "on when I have been given somewhere to send images" — dedicated
 * KNOWLEDGE_VISION_* credentials only. It used to mean "on when any API key
 * exists", so the ANTHROPIC_API_KEY configured for dreaming silently enrolled
 * every uploaded image in a third-party vision call nobody asked for. Naming a
 * provider explicitly is how you opt into spending the shared OPENAI_* pair (or
 * the Anthropic key) on OCR.
 */
export function resolveVisionTarget(env: Env): VisionTarget | null {
  const dedicated: Creds = {
    key: env.KNOWLEDGE_VISION_API_KEY,
    baseUrl: env.KNOWLEDGE_VISION_BASE_URL,
  };
  switch (env.KNOWLEDGE_VISION_PROVIDER) {
    case 'none':
      return null;
    case 'anthropic':
      return env.ANTHROPIC_API_KEY ? { provider: 'anthropic' } : null;
    default: {
      // 'openai' names the provider, which is the opt-in to spend the shared
      // pair; 'auto' falls through here on dedicated credentials alone.
      const shared = env.KNOWLEDGE_VISION_PROVIDER === 'openai' ? sharedOpenAICreds(env) : null;
      const creds = pickCreds(dedicated, shared);
      return creds ? { provider: 'openai', ...creds } : null;
    }
  }
}

/** Resolve the transcription capability. Same opt-in rule as vision. */
export function resolveTranscribeTarget(env: Env): Creds | null {
  if (env.KNOWLEDGE_TRANSCRIBE_PROVIDER === 'none') return null;
  const dedicated: Creds = {
    key: env.KNOWLEDGE_TRANSCRIBE_API_KEY,
    baseUrl: env.KNOWLEDGE_TRANSCRIBE_BASE_URL,
  };
  const shared = env.KNOWLEDGE_TRANSCRIBE_PROVIDER === 'openai' ? sharedOpenAICreds(env) : null;
  return pickCreds(dedicated, shared);
}

function defaultVisionModel(env: Env, target: VisionTarget): string {
  return target.provider === 'anthropic' ? env.ANTHROPIC_EXTRACTION_MODEL : 'gpt-4o-mini';
}

function describeEndpoint(creds: Creds): string {
  return creds.baseUrl ?? 'the provider API';
}

function describeDisabled(capability: string, envPrefix: string): string {
  return `[extraction] ${capability} disabled (set ${envPrefix}_* credentials, or name a provider to use the shared keys)`;
}

function describeVision(env: Env): string {
  const target = resolveVisionTarget(env);
  if (!target) return describeDisabled('image OCR', 'KNOWLEDGE_VISION');
  const model = env.KNOWLEDGE_VISION_MODEL ?? defaultVisionModel(env, target);
  const endpoint = target.provider === 'anthropic' ? 'the Anthropic API' : describeEndpoint(target);
  return `[extraction] image OCR → ${target.provider} ${model} at ${endpoint}`;
}

function describeTranscribe(env: Env): string {
  const target = resolveTranscribeTarget(env);
  if (!target) return describeDisabled('audio transcription', 'KNOWLEDGE_TRANSCRIBE');
  return `[extraction] audio transcription → ${env.KNOWLEDGE_TRANSCRIBE_MODEL} at ${describeEndpoint(target)}`;
}

/** One line per multimodal capability at boot. Whether a user's attachments
 *  leave the machine, and for where, should not be something you have to derive
 *  from four environment variables. */
export function describeExtractionCapabilities(env: Env): string[] {
  return [describeVision(env), describeTranscribe(env)];
}

// Build the MIME-routed extraction service. Text + PDF are always available;
// image (vision) and audio (transcription) call out to a provider when one is
// configured, and otherwise register a disabled stand-in so the attachment is
// recorded as 'skipped' with a reason rather than an ambiguous 'unsupported'.
export function buildExtractionService(env: Env): ExtractionService {
  const vision = resolveVisionTarget(env);
  // The vision extractor doubles as the PDF extractor's OCR fallback, so a
  // scanned PDF is read by whatever reads screenshots.
  const visionExtractor = vision
    ? createVisionExtractor({
        provider: vision.provider,
        model: env.KNOWLEDGE_VISION_MODEL ?? defaultVisionModel(env, vision),
        openaiApiKey: vision.key,
        openaiBaseUrl: vision.baseUrl,
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        timeoutMs: env.KNOWLEDGE_VISION_TIMEOUT_MS,
        maxDim: env.KNOWLEDGE_VISION_MAX_DIM,
        jpegQuality: env.KNOWLEDGE_VISION_JPEG_QUALITY,
        maxTokens: env.KNOWLEDGE_VISION_MAX_TOKENS,
      })
    : null;

  const extractors: Extractor[] = [
    createTextExtractor({ maxBytes: env.KNOWLEDGE_EXTRACT_MAX_TEXT_BYTES }),
    createPdfExtractor({
      ocrPage: visionExtractor ? (page) => visionExtractor.extract(page) : undefined,
      renderWidth: env.KNOWLEDGE_VISION_MAX_DIM,
      maxOcrPages: env.KNOWLEDGE_PDF_OCR_MAX_PAGES,
    }),
  ];

  extractors.push(
    visionExtractor ?? createDisabledExtractor(supportsImage, 'no vision provider configured'),
  );

  const transcribe = resolveTranscribeTarget(env);
  if (transcribe) {
    extractors.push(
      createAudioExtractor({
        model: env.KNOWLEDGE_TRANSCRIBE_MODEL,
        openaiApiKey: transcribe.key,
        openaiBaseUrl: transcribe.baseUrl,
        timeoutMs: env.KNOWLEDGE_TRANSCRIBE_TIMEOUT_MS,
      }),
    );
  } else {
    extractors.push(createDisabledExtractor(supportsAudio, 'no transcription provider configured'));
  }

  return createExtractionService(extractors);
}
