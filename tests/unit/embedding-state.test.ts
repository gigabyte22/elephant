import { describe, expect, test } from 'vitest';
import { embedModelId } from '../../src/adapters/factory.ts';
import type { Env } from '../../src/config/env.ts';
import { describeEmbeddingMismatch } from '../../src/embedding-state.ts';

describe('embedModelId', () => {
  test('names the provider and the model it will call', () => {
    const env = { OPENAI_EMBED_MODEL: 'text-embedding-3-small', OLLAMA_EMBED_MODEL: 'bge-m3' };
    expect(embedModelId({ ...env, MEMORY_EMBED_PROVIDER: 'openai' } as Env)).toBe(
      'openai:text-embedding-3-small',
    );
    expect(embedModelId({ ...env, MEMORY_EMBED_PROVIDER: 'ollama' } as Env)).toBe('ollama:bge-m3');
    expect(embedModelId({ ...env, MEMORY_EMBED_PROVIDER: 'voyage' } as Env)).toBe(
      'voyage:voyage-3',
    );
  });
});

describe('describeEmbeddingMismatch', () => {
  const stored = { embedModel: 'openai:text-embedding-3-large', embedDim: 1536 };

  test('matching settings are not a mismatch', () => {
    expect(describeEmbeddingMismatch({ ...stored }, stored)).toBeNull();
  });

  test('a new model at the same dimension is still a mismatch', () => {
    const msg = describeEmbeddingMismatch({ ...stored, embedModel: 'ollama:bge-m3' }, stored);
    expect(msg).toContain('model ollama:bge-m3 (graph has openai:text-embedding-3-large)');
    expect(msg).toContain('pnpm reembed');
  });

  test('names every difference', () => {
    const msg = describeEmbeddingMismatch({ embedModel: 'ollama:bge-m3', embedDim: 1024 }, stored);
    expect(msg).toContain('model ollama:bge-m3');
    expect(msg).toContain('EMBED_DIM 1024 (graph has 1536)');
  });
});
