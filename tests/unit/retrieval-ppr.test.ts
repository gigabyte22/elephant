// Hot-path guarantee: the PPR stages must be a pure no-op when PPR is disabled
// (the default). They early-return before any DB/LLM access, so the default
// recall pipeline is unchanged. Verified without a database.

import { describe, expect, test } from 'vitest';
import { createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { GraphPprStage } from '../../src/services/retrieval/stages/GraphPprStage.ts';
import { QueryEntityLinkStage } from '../../src/services/retrieval/stages/QueryEntityLinkStage.ts';
import { makeCtx, makeFact, makeState } from './retrieval-fixtures.ts';

describe('PPR stages are a no-op when disabled', () => {
  test('GraphPprStage returns state untouched and touches no DB', async () => {
    const ctx = makeCtx(); // fixtures default config.ppr.enabled = false
    const facts = [
      {
        fact: makeFact({ id: 'f1', entityIds: ['e1'] }),
        sources: [{ source: 'fact_vector' as const, rank: 0 }],
        expansionReason: 'fact_vector' as const,
        hasDirectHit: true,
      },
    ];
    const state = makeState(facts);
    const before = state.facts.size;

    // A throwing read() would surface as a rejection; reaching the DB at all
    // would fail here since no Neo4j is configured in unit tests.
    const out = await GraphPprStage(createFakeLLMAdapter()).run(ctx, state);
    expect(out.facts.size).toBe(before);
    expect(ctx.queryEntityIds).toBeUndefined();
  });

  test('QueryEntityLinkStage returns state untouched and sets no seeds', async () => {
    const ctx = makeCtx();
    const state = makeState([]);
    const out = await QueryEntityLinkStage().run(ctx, state);
    expect(out.facts.size).toBe(0);
    expect(ctx.queryEntityIds).toBeUndefined();
  });
});
