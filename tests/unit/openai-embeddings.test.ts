import { beforeEach, describe, expect, test, vi } from 'vitest';

const create = vi.fn(async (_args: Record<string, unknown>) => ({
  data: [{ index: 0, embedding: [0.1, 0.2] }],
}));

vi.mock('openai', () => ({
  default: class {
    embeddings = { create };
  },
}));

const { createOpenAIEmbeddingAdapter } = await import('../../src/adapters/embeddings/openai.ts');

describe('openai embedding adapter', () => {
  beforeEach(() => create.mockClear());

  test('sends dimensions for text-embedding-3 models', async () => {
    const adapter = createOpenAIEmbeddingAdapter({ model: 'text-embedding-3-small', dim: 1536 });
    await adapter.embed('hello');
    expect(create).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: ['hello'],
      dimensions: 1536,
    });
  });

  test('omits dimensions for other models', async () => {
    const adapter = createOpenAIEmbeddingAdapter({ model: 'nomic-embed-text', dim: 768 });
    await adapter.embed('hello');
    const args = create.mock.calls[0]?.[0] ?? {};
    expect(args).not.toHaveProperty('dimensions');
    expect(args.model).toBe('nomic-embed-text');
  });
});
