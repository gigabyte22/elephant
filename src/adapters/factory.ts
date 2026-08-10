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

// Resolve the vision provider for image extraction. 'auto' prefers Anthropic,
// then OpenAI, based on which API key is present; returns null when none.
// Dedicated KNOWLEDGE_VISION_* credentials win over the shared OPENAI_* pair, so
// pointing OCR at a local vision server never drags the LLM, embedding, or
// transcription adapters along with it.
function visionOpenAICreds(env: Env): { key?: string; baseUrl?: string } | null {
  const key = env.KNOWLEDGE_VISION_API_KEY || env.OPENAI_API_KEY;
  const baseUrl = env.KNOWLEDGE_VISION_BASE_URL || env.OPENAI_BASE_URL;
  return key || baseUrl ? { key, baseUrl } : null;
}

function transcribeOpenAICreds(env: Env): { key?: string; baseUrl?: string } | null {
  const key = env.KNOWLEDGE_TRANSCRIBE_API_KEY || env.OPENAI_API_KEY;
  const baseUrl = env.KNOWLEDGE_TRANSCRIBE_BASE_URL || env.OPENAI_BASE_URL;
  return key || baseUrl ? { key, baseUrl } : null;
}

function resolveVisionProvider(env: Env): 'openai' | 'anthropic' | null {
  if (env.KNOWLEDGE_VISION_PROVIDER === 'none') return null;
  if (env.KNOWLEDGE_VISION_PROVIDER === 'openai') return visionOpenAICreds(env) ? 'openai' : null;
  if (env.KNOWLEDGE_VISION_PROVIDER === 'anthropic')
    return env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  // auto
  if (env.KNOWLEDGE_VISION_BASE_URL || env.KNOWLEDGE_VISION_API_KEY) return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) return 'openai';
  return null;
}

function resolveTranscribeEnabled(env: Env): boolean {
  if (env.KNOWLEDGE_TRANSCRIBE_PROVIDER === 'none') return false;
  return transcribeOpenAICreds(env) !== null;
}

// Build the MIME-routed extraction service. Text + PDF are always available;
// image (vision) and audio (transcription) call out to a provider when one is
// configured, and otherwise register a disabled stand-in so the attachment is
// recorded as 'skipped' with a reason rather than an ambiguous 'unsupported'.
export function buildExtractionService(env: Env): ExtractionService {
  const extractors: Extractor[] = [createTextExtractor(), createPdfExtractor()];

  const vision = resolveVisionProvider(env);
  if (vision) {
    const creds = visionOpenAICreds(env);
    const defaultModel = vision === 'anthropic' ? env.ANTHROPIC_EXTRACTION_MODEL : 'gpt-4o-mini';
    extractors.push(
      createVisionExtractor({
        provider: vision,
        model: env.KNOWLEDGE_VISION_MODEL ?? defaultModel,
        openaiApiKey: creds?.key,
        openaiBaseUrl: creds?.baseUrl,
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        timeoutMs: env.KNOWLEDGE_VISION_TIMEOUT_MS,
        maxDim: env.KNOWLEDGE_VISION_MAX_DIM,
        jpegQuality: env.KNOWLEDGE_VISION_JPEG_QUALITY,
      }),
    );
  } else {
    extractors.push(createDisabledExtractor(supportsImage, 'no vision provider configured'));
  }

  if (resolveTranscribeEnabled(env)) {
    const creds = transcribeOpenAICreds(env);
    extractors.push(
      createAudioExtractor({
        model: env.KNOWLEDGE_TRANSCRIBE_MODEL,
        openaiApiKey: creds?.key,
        openaiBaseUrl: creds?.baseUrl,
        timeoutMs: env.KNOWLEDGE_TRANSCRIBE_TIMEOUT_MS,
      }),
    );
  } else {
    extractors.push(createDisabledExtractor(supportsAudio, 'no transcription provider configured'));
  }

  return createExtractionService(extractors);
}

/** Whether an attachment's text extraction should be deferred to the async
 *  worker. Vision and transcription calls take seconds to minutes — far past the
 *  30s timeout dobby's client applies to the upload request — so they are queued
 *  rather than run inline. Text and PDF stay synchronous; they are milliseconds. */
export function isDeferredExtraction(env: Env, mimeType: string): boolean {
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  if (supportsImage(mime)) return resolveVisionProvider(env) !== null;
  if (supportsAudio(mime)) return resolveTranscribeEnabled(env);
  return false;
}
