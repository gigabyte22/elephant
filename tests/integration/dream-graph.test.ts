// Phase 1 checkpoint: the dream cycle must build a real knowledge graph —
// (:Entity)-[:RELATES]->(:Entity) triples from LLM OpenIE, plus
// (:Entity)-[:SYNONYM]->(:Entity) alias edges from entity resolution, with
// entity embeddings re-derived from the entity name. Uses fake adapters so it
// needs no external LLM/embedder and runs against the isolated testcontainer.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { EmbeddingAdapter } from '../../src/adapters/embeddings/types.ts';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write as txWrite } from '../../src/config/neo4j.ts';
import { type Container, bootstrap, shutdown } from '../../src/index.ts';
import type { ExtractedFact, ExtractedRelation } from '../../src/models/types.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);

// Pin "Postgres" and "PostgreSQL" entity-name embeddings to the same vector so
// the resolution step sees them as synonyms (the bag-of-tokens fake otherwise
// makes the two distinct tokens orthogonal). Only entity-name embeds hit this —
// fact/transcript embeds are full sentences that never equal these exact names.
const SYNONYM_VEC = (() => {
  const v = new Array<number>(EMBED_DIM).fill(0);
  v[0] = 1;
  return v;
})();

let container: Container;

async function count(cypher: string): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(cypher);
    const val = r.records[0]?.get('n');
    if (val == null) return 0;
    return typeof val === 'number' ? val : (val as { toNumber(): number }).toNumber();
  });
}

beforeAll(async () => {
  const base = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
  const embedder: EmbeddingAdapter = {
    ...base,
    async embedBatch(texts) {
      return Promise.all(
        texts.map(async (t) => {
          const norm = t.trim().toLowerCase();
          if (norm === 'postgres' || norm === 'postgresql') return SYNONYM_VEC;
          return (await base.embedBatch([t]))[0]!;
        }),
      );
    },
  };

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
      if (t.includes('postgresql')) {
        facts.push({
          content: 'PostgreSQL is the main database',
          category: 'attribute',
          confidence: 0.8,
          importance: 0.5,
          entities: [{ name: 'PostgreSQL', type: 'tool' }],
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
      return rels;
    },
  });

  container = await bootstrap({ llm, embedder });
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

async function ingest(rawTranscript: string): Promise<void> {
  await container.ingestion.ingestEpisode({
    agentId: 'test-agent',
    sessionId: 's1',
    rawTranscript,
  });
}

describe('dream cycle builds the knowledge graph', () => {
  test('extracts RELATES triples, adds SYNONYM edges, re-embeds entities', async () => {
    await ingest('Alice manages Bob on the platform team.');
    await ingest('Bob chose Postgres for the new service.');
    await ingest('PostgreSQL is the main database for everything.');

    const run = await container.dreaming.runCycle();

    // Facts + entities landed.
    expect(run.factsCreated).toBeGreaterThanOrEqual(3);
    expect(await count('MATCH (e:Entity) RETURN count(e) AS n')).toBeGreaterThanOrEqual(4);

    // Relation extraction produced directed entity↔entity edges.
    expect(run.relationsCreated).toBeGreaterThanOrEqual(2);
    expect(
      await count('MATCH (:Entity)-[r:RELATES]->(:Entity) RETURN count(r) AS n'),
    ).toBeGreaterThanOrEqual(2);
    expect(
      await count(
        "MATCH (:Entity {name:'Alice'})-[r:RELATES {predicate:'manages'}]->(:Entity {name:'Bob'}) RETURN count(r) AS n",
      ),
    ).toBe(1);

    // Entity resolution: Postgres ~ PostgreSQL linked by a SYNONYM edge, and
    // entities were re-embedded from their name.
    expect(run.synonymsCreated).toBeGreaterThanOrEqual(1);
    expect(
      await count('MATCH (:Entity)-[s:SYNONYM]->(:Entity) RETURN count(s) AS n'),
    ).toBeGreaterThanOrEqual(1);
    expect(run.entitiesReembedded).toBeGreaterThanOrEqual(4);
  });

  test('multi-hop reachability: Alice → Bob → Postgres via RELATES', async () => {
    await ingest('Alice manages Bob on the platform team.');
    await ingest('Bob chose Postgres for the new service.');

    await container.dreaming.runCycle();

    // 2-hop path exists through the relation edges (undirected match).
    const path = await count(
      "MATCH (a:Entity {name:'Alice'})-[:RELATES*1..2]-(p:Entity {name:'Postgres'}) RETURN count(p) AS n",
    );
    expect(path).toBeGreaterThanOrEqual(1);
  });
});
