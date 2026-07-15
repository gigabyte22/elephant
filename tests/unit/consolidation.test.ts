import { describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter } from '../../src/adapters/fakes.ts';
import { type ClusterableFact, clusterForConsolidation } from '../../src/utils/consolidation.ts';

const embedder = createFakeEmbeddingAdapter({ dim: 256 });

async function fact(
  id: string,
  text: string,
  scope: { projectId?: string | null; userId?: string | null } = {},
): Promise<ClusterableFact> {
  return { id, embedding: await embedder.embed(text), ...scope };
}

const OPTS = { minSimilarity: 0.5, maxClusterSize: 6 };

describe('clusterForConsolidation', () => {
  test('groups similar facts, leaves dissimilar ones unclustered', async () => {
    const facts = await Promise.all([
      fact('a', 'the user daughter isabelle is six years old'),
      fact('b', 'the user daughter isabelle is the oldest'),
      fact('c', 'the user prefers postgres over mysql for databases'),
    ]);
    const clusters = clusterForConsolidation(facts, OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sort()).toEqual(['a', 'b']);
  });

  test('never clusters across scope buckets, even with identical content', async () => {
    const facts = await Promise.all([
      fact('a', 'the user daughter isabelle is six years old', { projectId: 'proj-A' }),
      fact('b', 'the user daughter isabelle is six years old', { projectId: 'proj-B' }),
      fact('c', 'the user daughter isabelle is six years old', { projectId: null }),
    ]);
    expect(clusterForConsolidation(facts, OPTS)).toHaveLength(0);
  });

  test('null vs set userId are separate buckets', async () => {
    const facts = await Promise.all([
      fact('a', 'the user daughter isabelle is six years old', { userId: 'u1' }),
      fact('b', 'the user daughter isabelle is six years old', { userId: null }),
    ]);
    expect(clusterForConsolidation(facts, OPTS)).toHaveLength(0);
  });

  test('same bucket with identical scope clusters normally', async () => {
    const facts = await Promise.all([
      fact('a', 'the user daughter isabelle is six years old', { projectId: 'p', userId: 'u' }),
      fact('b', 'isabelle the user daughter is six', { projectId: 'p', userId: 'u' }),
    ]);
    expect(clusterForConsolidation(facts, OPTS)).toHaveLength(1);
  });

  test('respects the similarity floor', async () => {
    const facts = await Promise.all([
      fact('a', 'the user daughter isabelle is six years old'),
      fact('b', 'the user daughter isabelle is the oldest'),
    ]);
    expect(clusterForConsolidation(facts, { ...OPTS, minSimilarity: 0.999 })).toHaveLength(0);
  });

  test('caps cluster size and clusters the remainder separately', async () => {
    const texts = Array.from({ length: 5 }, () => 'the user daughter isabelle is six years old');
    const facts = await Promise.all(texts.map((t, i) => fact(`f${i}`, t)));
    const clusters = clusterForConsolidation(facts, { ...OPTS, maxClusterSize: 3 });
    expect(clusters[0]).toHaveLength(3);
    // The two left over are still mutually similar → second cluster.
    expect(clusters[1]).toHaveLength(2);
  });

  test('deterministic output for the same input', async () => {
    const facts = await Promise.all([
      fact('c', 'the user daughter isabelle is six years old'),
      fact('a', 'the user daughter isabelle is the oldest'),
      fact('b', 'isabelle is the user daughter'),
    ]);
    const first = clusterForConsolidation(facts, OPTS);
    const second = clusterForConsolidation([...facts].reverse(), OPTS);
    expect(first.map((c) => [...c].sort())).toEqual(second.map((c) => [...c].sort()));
  });
});
