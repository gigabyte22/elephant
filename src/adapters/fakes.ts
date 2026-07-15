// Deterministic in-memory adapters for tests. Embeddings use a stable
// hash-based bag-of-tokens vector so cosine similarity is meaningful for
// duplicate-detection tests without depending on any network call.

import type {
  Episode,
  ExtractedFact,
  ExtractedRelation,
  Fact,
  SupersedeDecision,
} from '../models/types.ts';
import { approxTokens } from '../utils/tokens.ts';
import type { EmbeddingAdapter } from './embeddings/types.ts';
import type { LLMAdapter } from './llm/types.ts';

interface FakeEmbedOptions {
  dim?: number;
  maxInputTokens?: number;
}

export function createFakeEmbeddingAdapter(opts: FakeEmbedOptions = {}): EmbeddingAdapter {
  const dim = opts.dim ?? 1536;
  const maxInputTokens = opts.maxInputTokens ?? 8192;
  function tokenHash(token: string): number {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h = Math.imul(h ^ token.charCodeAt(i), 16777619);
    }
    return Math.abs(h);
  }
  function embedSync(text: string): number[] {
    const vec = new Array<number>(dim).fill(0);
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const idx = tokenHash(tok) % dim;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) vec[i] = (vec[i] ?? 0) / norm;
    return vec;
  }
  return {
    name: `fake-embed(dim=${dim})`,
    dim,
    maxInputTokens,
    async countTokens(text: string): Promise<number> {
      return approxTokens(text);
    },
    async embed(text: string): Promise<number[]> {
      return embedSync(text);
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(embedSync);
    },
  };
}

interface FakeLLMOptions {
  extract?: (input: { episode: Episode }) => ExtractedFact[];
  supersede?: (input: {
    candidate: Pick<Fact, 'id' | 'content'>;
    existing: Pick<Fact, 'id' | 'content'>[];
  }) => Omit<SupersedeDecision, 'newFactId'> | null;
  summarize?: (input: { text: string; targetTokens?: number }) => string;
  relations?: (input: {
    text: string;
    entities: Array<{ name: string; type: string }>;
  }) => ExtractedRelation[];
  rerank?: (input: {
    query: string;
    candidates: Array<{ id: string; content: string }>;
    keepTopK: number;
  }) => Array<{ id: string; score: number; reason?: string }>;
  consolidate?: (input: {
    cluster: Array<{
      id: string;
      content: string;
      category?: string;
      confidence: number;
      importance: number;
    }>;
  }) => {
    decision: 'merge' | 'keep';
    mergeFactIds: string[];
    content: string;
    category?: string;
    confidence: number;
    importance: number;
  } | null;
  maxContextTokens?: number;
}

export function createFakeLLMAdapter(opts: FakeLLMOptions = {}): LLMAdapter {
  return {
    name: 'fake-llm',
    maxContextTokens: opts.maxContextTokens ?? 32_000,
    async countTokens(text: string): Promise<number> {
      return approxTokens(text);
    },
    async extractFacts({ episode }) {
      return opts.extract?.({ episode }) ?? [];
    },
    async extractRelations(input) {
      return opts.relations?.(input) ?? [];
    },
    async detectSupersede(input) {
      return opts.supersede?.(input) ?? null;
    },
    async consolidateFacts(input) {
      return opts.consolidate?.(input) ?? null;
    },
    async summarize(input) {
      if (opts.summarize) return opts.summarize(input);
      // Default: first 200 chars with a marker so tests can detect that the
      // real summarize path was exercised.
      const head = input.text.slice(0, 200).replace(/\s+/g, ' ').trim();
      return `[fake-summary] ${head}`;
    },
    async rerank(input) {
      if (opts.rerank) return opts.rerank(input);
      // Default: identity ordering with descending synthetic scores so tests
      // without a custom rerank still see a stable, non-trivial score shape.
      return input.candidates.map((c, i) => ({
        id: c.id,
        score: Math.max(0, 1 - i * 0.05),
      }));
    },
  };
}
