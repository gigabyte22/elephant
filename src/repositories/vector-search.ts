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
// filter actually bites. K grows by `growth` per attempt, except that the last
// permitted attempt jumps straight to `maxK`: the ceiling is always tried
// before starvation is reported. With the defaults (growth 4, 3 attempts,
// maxK 2000) and a start K of 60 that is 60 → 240 → 2000; the common case — an
// unfiltered or weakly-filtered search — returns on the first. The first
// attempt always runs at the start K, so with `maxAttempts: 1` there is no
// escalation at all and `starved` is true only if the start K already reached
// the ceiling.
//
// A short result is not always a filter problem: when K already covers every
// node the index could hold, the index has nothing more to give and widening K
// is pointless. Callers pass `population` (an O(1) label count, see
// `countLabel`) so the loop can tell the two apart; it is consulted lazily,
// only after a short attempt, and a failure to count is treated as unknown.
// Without it a sparse graph — a new deployment with a handful of insights —
// would run the ceiling query and be reported starved on every recall.

import type { ManagedTransaction } from 'neo4j-driver';

export interface AnnOutcome<T> {
  hits: T[];
  /** K handed to the index on the last query actually run. */
  requestedK: number;
  attempts: number;
  /** `want` was not met AND the last query run was already at the ceiling
   *  (`requestedK >= maxK`), so the filter, not an absence of data, cost the
   *  missing rows. Never true when `requestedK` covered the whole `population`. */
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
  /** Upper bound on the nodes the index can return (e.g. the label count).
   *  Once K reaches it, the index is exhausted: stop, and do not report starved. */
  population?: () => Promise<number>;
}): Promise<AnnOutcome<T>> {
  const { want, config } = input;
  const maxK = Math.max(config.maxK, input.startK);
  const maxAttempts = Math.max(1, config.maxAttempts);
  const growth = Math.max(2, config.growth);
  // undefined = not counted yet; null = the count failed (unknown: fall back to
  // the K-only rule).
  let population: number | null | undefined;
  async function indexExhausted(k: number): Promise<boolean> {
    if (!input.population) return false;
    if (population === undefined) {
      try {
        population = await input.population();
      } catch {
        population = null;
      }
    }
    return population !== null && k >= population;
  }

  let k = Math.min(Math.max(1, input.startK), maxK);
  for (let attempts = 1; ; attempts += 1) {
    const hits = await input.run(k);
    // Enough rows, or nothing more to give: either way the search is not starved.
    if (hits.length >= want || (await indexExhausted(k))) {
      return { hits, requestedK: k, attempts, starved: false };
    }
    if (k >= maxK || attempts >= maxAttempts) {
      return { hits, requestedK: k, attempts, starved: k >= maxK };
    }
    // The next attempt is the last one allowed: spend it on the ceiling.
    k = attempts + 1 >= maxAttempts ? maxK : Math.min(k * growth, maxK);
  }
}

/** O(1) node count for a vector-indexed label (served from the count store),
 *  used as `population` above. `label` is a code constant, never user input. */
export async function countLabel(
  tx: ManagedTransaction,
  label: 'Fact' | 'Insight' | 'Preference',
): Promise<number> {
  const result = await tx.run(`MATCH (n:${label}) RETURN count(n) AS n`);
  return (result.records[0]?.get('n') as number) ?? 0;
}
