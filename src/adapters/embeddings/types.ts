export interface EmbeddingAdapter {
  name: string;
  // Vector dimensionality. MUST equal the configured EMBED_DIM, or the service
  // refuses to start (see src/index.ts boot check).
  dim: number;
  // Largest input the backend will accept without silently truncating. Callers
  // that exceed this MUST chunk — see Chunker.ts. The value is per-text, not
  // per-batch.
  maxInputTokens: number;
  // Estimated token count for `text`. Default implementations use a char-ratio
  // heuristic — override when exact counts matter (e.g. OpenAI via tiktoken).
  countTokens(text: string): Promise<number>;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
