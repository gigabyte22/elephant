import OpenAI from 'openai';
import { approxTokens } from '../../utils/tokens.ts';
import type { EmbeddingAdapter } from './types.ts';

interface OpenAIEmbedAdapterConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
  dim: number;
  maxInputTokens?: number;
}

// All current OpenAI embedding models share 8191 tokens. Generic OpenAI-compatible
// servers (via baseURL) may differ — user override via EMBED_MAX_INPUT_TOKENS.
const DEFAULT_MAX_INPUT_TOKENS = 8191;

export function createOpenAIEmbeddingAdapter(config: OpenAIEmbedAdapterConfig): EmbeddingAdapter {
  const client = new OpenAI({
    apiKey: config.apiKey ?? 'unused',
    baseURL: config.baseURL,
  });
  const maxInputTokens = config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;

  async function embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await client.embeddings.create({
      model: config.model,
      input: texts,
    });
    return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding as number[]);
  }

  return {
    name: `openai-embed(${config.model}${config.baseURL ? `@${config.baseURL}` : ''})`,
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
