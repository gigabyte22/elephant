// Voyage AI embeddings (https://docs.voyageai.com/reference/embeddings-api).
// Native HTTP — no SDK dep needed.

import { approxTokens } from '../../utils/tokens.ts';
import type { EmbeddingAdapter } from './types.ts';

interface VoyageEmbedAdapterConfig {
  apiKey: string;
  model: string;
  dim: number;
  maxInputTokens?: number;
}

interface VoyageEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

// voyage-3 / voyage-3-large / voyage-code-3 all support 32k tokens per input.
const DEFAULT_MAX_INPUT_TOKENS = 32_000;

export function createVoyageEmbeddingAdapter(config: VoyageEmbedAdapterConfig): EmbeddingAdapter {
  const maxInputTokens = config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;

  async function embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(`Voyage embed failed: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as VoyageEmbedResponse;
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  return {
    name: `voyage(${config.model})`,
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
