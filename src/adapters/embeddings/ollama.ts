// Ollama embeddings via its native /api/embed endpoint.
// Variable dim — the caller must set EMBED_DIM to match the chosen model
// (e.g. nomic-embed-text=768, mxbai-embed-large=1024). Migrate script enforces.

import { approxTokens } from '../../utils/tokens.ts';
import type { EmbeddingAdapter } from './types.ts';

interface OllamaEmbedAdapterConfig {
  baseURL: string;
  model: string;
  dim: number;
  maxInputTokens?: number;
}

interface OllamaEmbedResponse {
  embeddings: number[][];
}

// BERT-family embedders served by Ollama all land near 512 tokens; nomic-embed's
// "long" variant reaches 2048. Conservative default avoids silent truncation;
// users with longer-context models override via EMBED_MAX_INPUT_TOKENS.
const MODEL_MAX_INPUT_TOKENS: Record<string, number> = {
  'mxbai-embed-large': 512,
  'nomic-embed-text': 2048,
  'all-minilm': 256,
};

function defaultMaxInputTokens(model: string): number {
  for (const [prefix, limit] of Object.entries(MODEL_MAX_INPUT_TOKENS)) {
    if (model.startsWith(prefix)) return limit;
  }
  return 512;
}

export function createOllamaEmbeddingAdapter(config: OllamaEmbedAdapterConfig): EmbeddingAdapter {
  const url = `${config.baseURL.replace(/\/$/, '')}/api/embed`;
  const maxInputTokens = config.maxInputTokens ?? defaultMaxInputTokens(config.model);

  async function embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as OllamaEmbedResponse;
    return data.embeddings;
  }

  return {
    name: `ollama-embed(${config.model}@${config.baseURL})`,
    dim: config.dim,
    maxInputTokens,
    async countTokens(text: string): Promise<number> {
      return approxTokens(text);
    },
    async embed(text: string): Promise<number[]> {
      const [vec] = await embedBatch([text]);
      return vec ?? [];
    },
    embedBatch,
  };
}
