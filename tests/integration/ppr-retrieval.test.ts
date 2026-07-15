// Phase 3 verification: Personalized PageRank retrieval surfaces multi-hop-
// relevant facts that dense/full-text recall misses. Requires the GDS plugin
// (gds.pageRank) — runs against the isolated testcontainer/throwaway DB.
//
// Scenario: "Alice manages Bob", "Bob chose Postgres", "Postgres runs on
// Linux". A query for "Alice" surfaces the Alice fact (dense) and, via the
// existing 1-hop sibling expansion, "Bob chose Postgres" (shares entity Bob).
// But "Postgres runs on Linux" is 2 hops out (shares no entity with the Alice
// fact) — out of sibling reach. PPR seeded from Alice flows Alice→Bob→Postgres
// →Linux and is the only thing that surfaces it.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import type { ExtractedFact, ExtractedRelation } from '../../src/models/types.ts';
import { FactRepository } from '../../src/repositories/FactRepository.ts';
import { PPR_GRAPH_NAME } from '../../src/services/graph/GraphProjectionService.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);

let container: Container;
// PPR needs the GDS plugin (gds.pageRank). The shared testcontainer doesn't
// install it by default, so these tests skip when it's absent rather than fail.
let gdsAvailable = false;

beforeAll(async () => {
  const embedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  const llm = createFakeLLMAdapter({
    extract: ({ episode }): ExtractedFact[] => {
      const t = episode.rawTranscript.toLowerCase();
      const facts: ExtractedFact[] = [];
      if (t.includes('alice') && t.includes('bob')) {
        facts.push({
          content: 'Alice manages Bob',
          category: 'relationship',
          confidence: 0.9,
          importance: 0.6,
          entities: [
            { name: 'Alice', type: 'person' },
            { name: 'Bob', type: 'person' },
          ],
          entityNames: [],
        });
      }
      if (t.includes('bob') && t.includes('postgres')) {
        facts.push({
          content: 'Bob chose Postgres',
          category: 'decision',
          confidence: 0.9,
          importance: 0.6,
          entities: [
            { name: 'Bob', type: 'person' },
            { name: 'Postgres', type: 'tool' },
          ],
          entityNames: [],
        });
      }
      if (t.includes('postgres') && t.includes('linux')) {
        facts.push({
          content: 'Postgres runs on Linux',
          category: 'attribute',
          confidence: 0.9,
          importance: 0.6,
          entities: [
            { name: 'Postgres', type: 'tool' },
            { name: 'Linux', type: 'tool' },
          ],
          entityNames: [],
        });
      }
      return facts;
    },
    relations: ({ entities }): ExtractedRelation[] => {
      const names = new Set(entities.map((e) => e.name.toLowerCase()));
      const rels: ExtractedRelation[] = [];
      if (names.has('alice') && names.has('bob')) {
        rels.push({ subject: 'Alice', predicate: 'manages', object: 'Bob', confidence: 0.95 });
      }
      if (names.has('bob') && names.has('postgres')) {
        rels.push({ subject: 'Bob', predicate: 'chose', object: 'Postgres', confidence: 0.95 });
      }
      if (names.has('postgres') && names.has('linux')) {
        rels.push({
          subject: 'Postgres',
          predicate: 'runs_on',
          object: 'Linux',
          confidence: 0.95,
        });
      }
      return rels;
    },
  });

  container = await bootstrap({ llm, embedder });

  gdsAvailable = await read(async (tx) => {
    const r = await tx.run(
      "SHOW PROCEDURES YIELD name WHERE name = 'gds.pageRank.stream' RETURN count(*) AS n",
    );
    const n = r.records[0]?.get('n');
    return (typeof n === 'number' ? n : ((n as { toNumber(): number })?.toNumber() ?? 0)) > 0;
  }).catch(() => false);
}, 180_000);

afterAll(async () => {
  await shutdown();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
});

async function seedAndDream(): Promise<void> {
  await container.ingestion.ingestEpisode({
    agentId: 'a',
    sessionId: 's1',
    rawTranscript: 'Alice manages Bob on the platform team.',
  });
  await container.ingestion.ingestEpisode({
    agentId: 'a',
    sessionId: 's1',
    rawTranscript: 'Bob chose Postgres for the new service.',
  });
  await container.ingestion.ingestEpisode({
    agentId: 'a',
    sessionId: 's1',
    rawTranscript: 'Postgres runs on Linux in production.',
  });
  await container.dreaming.runCycle();
}

describe('Personalized PageRank retrieval', () => {
  test('GDS projection is built by the dream cycle', async (ctx) => {
    if (!gdsAvailable) return ctx.skip();
    await seedAndDream();
    expect(await container.graphProjection.exists()).toBe(true);
  });

  test('PageRank seeded from Alice reaches the 2-hop fact, ranked by score', async (ctx) => {
    if (!gdsAvailable) return ctx.skip();
    await seedAndDream();

    // Seed PPR from the Alice entity only.
    const aliceId = await read(async (tx) => {
      const r = await tx.run("MATCH (e:Entity {name:'Alice'}) RETURN e.id AS id");
      return r.records[0]?.get('id') as string;
    });
    expect(aliceId).toBeTruthy();

    const hits = await read((tx) =>
      FactRepository.pprFactsByEntities(tx, {
        seedEntityIds: [aliceId],
        excludeFactIds: [],
        limit: 10,
        includeSuperseded: false,
        graphName: PPR_GRAPH_NAME,
        dampingFactor: 0.85,
        maxIterations: 20,
      }),
    );

    const byContent = new Map(hits.map((f) => [f.content, f.score]));
    // The 2-hop fact (Alice→Bob→Postgres→Linux) is reached by PageRank...
    expect(byContent.has('Postgres runs on Linux')).toBe(true);
    // ...along with the closer facts, all with positive PageRank mass.
    expect(byContent.has('Alice manages Bob')).toBe(true);
    expect(byContent.has('Bob chose Postgres')).toBe(true);
    for (const score of byContent.values()) expect(score).toBeGreaterThan(0);
    // Closer hops should not score below the farther one (monotone decay).
    expect(byContent.get('Alice manages Bob')!).toBeGreaterThanOrEqual(
      byContent.get('Postgres runs on Linux')!,
    );
  });

  test('full recall pipeline runs with ppr=true and returns facts', async (ctx) => {
    if (!gdsAvailable) return ctx.skip();
    await seedAndDream();
    const r = await container.retrieval.recall({ q: 'Alice', ppr: true, limit: 20 });
    expect(r.facts.length).toBeGreaterThan(0);
  });
});
