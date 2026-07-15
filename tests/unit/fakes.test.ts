import { describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter } from '../../src/adapters/fakes.ts';
import { cosine } from '../../src/utils/cosine.ts';

describe('fake embedding adapter', () => {
  const embedder = createFakeEmbeddingAdapter({ dim: 256 });

  test('embed returns a unit vector of the configured dim', async () => {
    const vec = await embedder.embed('hello world');
    expect(vec).toHaveLength(256);
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  test('similar texts have higher cosine than unrelated', async () => {
    const a = await embedder.embed('user prefers dark mode');
    const b = await embedder.embed('user prefers light mode');
    const c = await embedder.embed('the cat sat on the mat');
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });

  test('embedBatch matches embed', async () => {
    const [a, b] = await embedder.embedBatch(['x', 'y']);
    expect(a).toEqual(await embedder.embed('x'));
    expect(b).toEqual(await embedder.embed('y'));
  });
});
