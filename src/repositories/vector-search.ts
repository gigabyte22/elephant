// Adaptive K for Neo4j vector search.
//
// `db.index.vector.queryNodes(index, K, vec)` returns the GLOBAL top-K and
// every predicate in the following WHERE is a post-filter. For a filter of
// selectivity `s`, survivors ≈ K·s — so recall starves whenever K·s < limit,
// and it fails as a 200 with an empty array, indistinguishable from "nothing
// matched". The failure gets worse as the graph grows, which is the opposite
// of what an operator expects.
//
// `asOfOverfetchLimit` in the retrieval stages already applies this reasoning
// to one axis (historical as-of). This generalises it: rather than guessing a
// single multiplier per axis, re-query with escalating K until enough rows
// survive the filter or K hits a ceiling.
//
// Each attempt is a full ANN query, so the loop only costs anything when the
// filter actually bites. With the default growth of 4 the worst case is three
// queries; the common case — an unfiltered or weakly-filtered search — returns
// on the first.

export interface AnnOutcome<T> {
  hits: T[];
  /** K handed to the index on the final attempt. */
  requestedK: number;
  attempts: number;
  /** `want` was not met AND K reached the ceiling. */
  starved: boolean;
}

export interface AnnEscalationConfig {
  maxK: number;
  growth: number;
  maxAttempts: number;
}

export async function annWithEscalation<T>(input: {
  want: number;
  startK: number;
  config: AnnEscalationConfig;
  run: (k: number) => Promise<T[]>;
}): Promise<AnnOutcome<T>> {
  const { want, config } = input;
  const maxK = Math.max(config.maxK, input.startK);
  let k = Math.min(Math.max(1, input.startK), maxK);
  let hits: T[] = [];
  let attempts = 0;

  while (attempts < Math.max(1, config.maxAttempts)) {
    hits = await input.run(k);
    attempts += 1;
    if (hits.length >= want || k >= maxK) break;
    k = Math.min(k * Math.max(2, config.growth), maxK);
  }

  return {
    hits,
    requestedK: k,
    attempts,
    starved: hits.length < want && k >= maxK,
  };
}
