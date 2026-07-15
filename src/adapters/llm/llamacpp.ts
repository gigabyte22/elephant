// llama.cpp's HTTP server speaks the OpenAI chat-completions API on `/v1`,
// so we reuse the OpenAI adapter with a custom baseURL. Keeping a separate
// factory entrypoint here so the env-driven selector has a clean discriminator,
// and so future llama.cpp-specific options (json grammar files, sampling
// overrides, turboquant tuning) can be added without contaminating the OpenAI
// adapter.

import { createOpenAILLMAdapter } from './openai.ts';
import type { LLMAdapter } from './types.ts';

interface LlamaCppAdapterConfig {
  baseURL: string;
  model: string;
  // n_ctx at server startup. Varies widely across local builds (4k–1M+).
  maxContextTokens?: number;
}

export function createLlamaCppLLMAdapter(config: LlamaCppAdapterConfig): LLMAdapter {
  const inner = createOpenAILLMAdapter({
    baseURL: config.baseURL.endsWith('/v1') ? config.baseURL : `${config.baseURL}/v1`,
    model: config.model,
    // llama.cpp defaults are typically 4k–32k; use a safe fallback if caller
    // hasn't read their n_ctx_train.
    maxContextTokens: config.maxContextTokens ?? 8192,
  });
  return { ...inner, name: `llamacpp(${config.model}@${config.baseURL})` };
}
