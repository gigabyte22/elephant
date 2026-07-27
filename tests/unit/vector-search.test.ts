// Adaptive K for Neo4j vector search.
//
// queryNodes returns the GLOBAL top-K and predicates run afterwards, so for a
// filter of selectivity s survivors ≈ K·s — recall starves whenever K·s falls
// below `limit`, and reports it as a 200 with an empty array. Escalation
// re-queries with a wider K until enough rows survive or K hits a ceiling.

import { describe, expect, test, vi } from 'vitest';
import { annWithEscalation } from '../../src/repositories/vector-search.ts';

const config = { maxK: 2000, growth: 4, maxAttempts: 3 };

describe('annWithEscalation', () => {
  test('returns on the first attempt when the filter is not selective', async () => {
    const run = vi.fn(async () => [1, 2, 3, 4, 5]);
    const out = await annWithEscalation({ want: 5, startK: 60, config, run });

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(60);
    expect(out).toMatchObject({ attempts: 1, requestedK: 60, starved: false });
  });

  test('escalates by `growth` until enough rows survive', async () => {
    const ks: number[] = [];
    const run = vi.fn(async (k: number) => {
      ks.push(k);
      // 1% of K survives the filter.
      return Array.from({ length: Math.floor(k / 100) }, (_, i) => i);
    });

    const out = await annWithEscalation({ want: 5, startK: 60, config, run });

    expect(ks).toEqual([60, 240, 960]);
    expect(out.attempts).toBe(3);
    expect(out.hits.length).toBeGreaterThanOrEqual(5);
    expect(out.starved).toBe(false);
  });

  test('clamps at maxK rather than overshooting', async () => {
    const ks: number[] = [];
    const run = vi.fn(async (k: number) => {
      ks.push(k);
      return [];
    });

    await annWithEscalation({ want: 10, startK: 500, config, run });

    expect(ks).toEqual([500, 2000]);
    expect(Math.max(...ks)).toBeLessThanOrEqual(config.maxK);
  });

  test('stops at maxAttempts even if still short', async () => {
    const run = vi.fn(async () => [1]);
    const out = await annWithEscalation({
      want: 100,
      startK: 10,
      config: { maxK: 1_000_000, growth: 2, maxAttempts: 2 },
      run,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(out.attempts).toBe(2);
    // Not starved: K never reached the ceiling, so a wider budget could still
    // have helped. Only a ceiling hit is a genuine index-side starvation.
    expect(out.starved).toBe(false);
  });

  test('reports starved only when want is unmet AND K hit the ceiling', async () => {
    const out = await annWithEscalation({
      want: 10,
      startK: 2000,
      config,
      run: async () => [1, 2],
    });

    expect(out.attempts).toBe(1);
    expect(out.starved).toBe(true);
  });

  test('a startK above maxK is honoured rather than shrunk', async () => {
    const ks: number[] = [];
    await annWithEscalation({
      want: 1,
      startK: 5000,
      config,
      run: async (k) => {
        ks.push(k);
        return [];
      },
    });
    expect(ks).toEqual([5000]);
  });
});
