// Reciprocal Rank Fusion: combine multiple ranked lists into one.
// Score = sum_over_lists ( 1 / (k + rank_in_list) ).
// k=60 is the canonical default from Cormack et al.

export function reciprocalRankFusion<T>(
  lists: T[][],
  keyOf: (item: T) => string,
  k = 60,
): Array<{ key: string; score: number; samples: T[] }> {
  const scores = new Map<string, { score: number; samples: T[] }>();
  for (const list of lists) {
    list.forEach((item, i) => {
      const key = keyOf(item);
      const entry = scores.get(key) ?? { score: 0, samples: [] };
      entry.score += 1 / (k + i + 1);
      entry.samples.push(item);
      scores.set(key, entry);
    });
  }
  return Array.from(scores.entries())
    .map(([key, v]) => ({ key, score: v.score, samples: v.samples }))
    .sort((a, b) => b.score - a.score);
}
