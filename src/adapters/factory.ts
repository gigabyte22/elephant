import type { Env } from '../config/env.ts';
import { createOllamaEmbeddingAdapter } from './embeddings/ollama.ts';
import { createOpenAIEmbeddingAdapter } from './embeddings/openai.ts';
import type { EmbeddingAdapter } from './embeddings/types.ts';
import { createVoyageEmbeddingAdapter } from './embeddings/voyage.ts';
import { createAudioExtractor } from './extraction/audio-extractor.ts';
import { createPdfExtractor } from './extraction/pdf-extractor.ts';
import { createExtractionService } from './extraction/service.ts';
import { createTextExtractor } from './extraction/text-extractor.ts';
import type { ExtractionService, Extractor } from './extraction/types.ts';
import { createVisionExtractor } from './extraction/vision-extractor.ts';
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
function resolveVisionProvider(env: Env): 'openai' | 'anthropic' | null {
  if (env.KNOWLEDGE_VISION_PROVIDER === 'none') return null;
  if (env.KNOWLEDGE_VISION_PROVIDER === 'openai')
    return env.OPENAI_API_KEY || env.OPENAI_BASE_URL ? 'openai' : null;
  if (env.KNOWLEDGE_VISION_PROVIDER === 'anthropic')
    return env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  // auto
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) return 'openai';
  return null;
}

function resolveTranscribeEnabled(env: Env): boolean {
  if (env.KNOWLEDGE_TRANSCRIBE_PROVIDER === 'none') return false;
  return Boolean(env.OPENAI_API_KEY || env.OPENAI_BASE_URL);
}

// Build the MIME-routed extraction service. Text + PDF are always available;
// image (vision) and audio (transcription) are included only when a provider
// is configured — otherwise those attachments are stored but not text-indexed.
export function buildExtractionService(env: Env): ExtractionService {
  const extractors: Extractor[] = [createTextExtractor(), createPdfExtractor()];

  const vision = resolveVisionProvider(env);
  if (vision) {
    const defaultModel = vision === 'anthropic' ? env.ANTHROPIC_EXTRACTION_MODEL : 'gpt-4o-mini';
    extractors.push(
      createVisionExtractor({
        provider: vision,
        model: env.KNOWLEDGE_VISION_MODEL ?? defaultModel,
        openaiApiKey: env.OPENAI_API_KEY,
        openaiBaseUrl: env.OPENAI_BASE_URL,
        anthropicApiKey: env.ANTHROPIC_API_KEY,
      }),
    );
  }

  if (resolveTranscribeEnabled(env)) {
    extractors.push(
      createAudioExtractor({
        model: env.KNOWLEDGE_TRANSCRIBE_MODEL,
        openaiApiKey: env.OPENAI_API_KEY,
        openaiBaseUrl: env.OPENAI_BASE_URL,
      }),
    );
  }

  return createExtractionService(extractors);
}
