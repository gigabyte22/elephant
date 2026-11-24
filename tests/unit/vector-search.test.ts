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

  test('escalates by `growth`, spending the last attempt on the ceiling', async () => {
    const ks: number[] = [];
    const run = vi.fn(async (k: number) => {
      ks.push(k);
      // 1% of K survives the filter.
      return Array.from({ length: Math.floor(k / 100) }, (_, i) => i);
    });

    const out = await annWithEscalation({ want: 5, startK: 60, config, run });

    expect(ks).toEqual([60, 240, 2000]);
    expect(out.attempts).toBe(3);
    expect(out.requestedK).toBe(2000);
    expect(out.hits.length).toBeGreaterThanOrEqual(5);
    expect(out.starved).toBe(false);
  });

  test('exits early once enough rows survive, without jumping to the ceiling', async () => {
    const ks: number[] = [];
    const run = vi.fn(async (k: number) => {
      ks.push(k);
      // 5% of K survives: 3 rows at 60, 12 at 240.
      return Array.from({ length: Math.floor(k / 20) }, (_, i) => i);
    });

    const out = await annWithEscalation({ want: 5, startK: 60, config, run });

    expect(ks).toEqual([60, 240]);
    expect(out).toMatchObject({ attempts: 2, requestedK: 240, starved: false });
  });

  test('reports the K of the last query actually run', async () => {
    const ks: number[] = [];
    const out = await annWithEscalation({
      want: 10,
      startK: 60,
      config: { maxK: 1_000_000, growth: 4, maxAttempts: 4 },
      run: async (k) => {
        ks.push(k);
        return k >= 960 ? Array.from({ length: 10 }, (_, i) => i) : [];
      },
    });

    expect(ks).toEqual([60, 240, 960]);
    expect(out.requestedK).toBe(ks.at(-1));
    expect(out.starved).toBe(false);
  });

  test('the ceiling is reached on the last attempt before starvation is reported', async () => {
    const ks: number[] = [];
    const out = await annWithEscalation({
      want: 10,
      startK: 60,
      config,
      run: async (k) => {
        ks.push(k);
        return [];
      },
    });

    expect(ks).toEqual([60, 240, 2000]);
    expect(out).toMatchObject({ attempts: 3, requestedK: 2000, starved: true });
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

  test('stops at maxAttempts even if still short, having tried the ceiling', async () => {
    const run = vi.fn(async (_k: number) => [1]);
    const out = await annWithEscalation({
      want: 100,
      startK: 10,
      config: { maxK: 1_000_000, growth: 2, maxAttempts: 2 },
      run,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map((c) => c[0])).toEqual([10, 1_000_000]);
    expect(out).toMatchObject({ attempts: 2, requestedK: 1_000_000, starved: true });
  });

  test('maxAttempts 1 runs once at the start K and is not starved below the ceiling', async () => {
    const run = vi.fn(async (_k: number) => [1]);
    const out = await annWithEscalation({
      want: 100,
      startK: 60,
      config: { ...config, maxAttempts: 1 },
      run,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(60);
    // Not starved: K never reached the ceiling, so a wider budget could still
    // have helped. Only a ceiling hit is a genuine index-side starvation.
    expect(out).toMatchObject({ attempts: 1, requestedK: 60, starved: false });
  });

  test('maxAttempts 1 at a start K already on the ceiling is starved', async () => {
    const out = await annWithEscalation({
      want: 100,
      startK: 2000,
      config: { ...config, maxAttempts: 1 },
      run: async () => [1],
    });
    expect(out).toMatchObject({ attempts: 1, requestedK: 2000, starved: true });
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

  describe('population (index exhaustion)', () => {
    test('a sparse index stops escalating once K covers it and is not starved', async () => {
      const ks: number[] = [];
      const population = vi.fn(async () => 3);
      const out = await annWithEscalation({
        want: 10,
        startK: 30,
        config,
        run: async (k) => {
          ks.push(k);
          return [1, 2, 3];
        },
        population,
      });

      expect(ks).toEqual([30]);
      expect(population).toHaveBeenCalledOnce();
      expect(out).toMatchObject({ attempts: 1, requestedK: 30, starved: false });
    });

    test('a large index still escalates to the ceiling and reports starvation', async () => {
      const ks: number[] = [];
      const population = vi.fn(async () => 1_000_000);
      const out = await annWithEscalation({
        want: 10,
        startK: 60,
        config,
        run: async (k) => {
          ks.push(k);
          return [];
        },
        population,
      });

      expect(ks).toEqual([60, 240, 2000]);
      // Counted once, lazily, however many attempts follow.
      expect(population).toHaveBeenCalledOnce();
      expect(out).toMatchObject({ requestedK: 2000, starved: true });
    });

    test('the ceiling covering the whole index is exhaustion, not starvation', async () => {
      const out = await annWithEscalation({
        want: 10,
        startK: 60,
        config,
        run: async () => [1],
        population: async () => 1500,
      });
      expect(out).toMatchObject({ attempts: 3, requestedK: 2000, starved: false });
    });

    test('is not consulted when the first attempt is enough', async () => {
      const population = vi.fn(async () => 0);
      await annWithEscalation({ want: 1, startK: 60, config, run: async () => [1], population });
      expect(population).not.toHaveBeenCalled();
    });

    test('a failing count degrades to the K-only rule', async () => {
      const out = await annWithEscalation({
        want: 10,
        startK: 60,
        config,
        run: async () => [],
        population: async () => {
          throw new Error('neo4j unreachable');
        },
      });
      expect(out).toMatchObject({ attempts: 3, requestedK: 2000, starved: true });
    });
  });
});
