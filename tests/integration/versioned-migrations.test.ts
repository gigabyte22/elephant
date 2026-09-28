// The migration ledger and the embedding record: migrate() applies each data
// migration once, a re-run changes nothing, and boot refuses to serve against
// vectors from a different embedder. Every spec wipes the shared graph, so this
// one re-runs migrate() on the empty graph first rather than trusting setup.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { readEmbeddingState, writeEmbeddingState } from '../../src/embedding-state.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, shutdown } from '../../src/index.ts';
import { migrate } from '../../src/migrate.ts';
import { MIGRATIONS } from '../../src/migrations.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const CONFIGURED = { embedModel: 'openai:text-embedding-3-large', embedDim: EMBED_DIM };
const adapters = () => ({
  llm: createFakeLLMAdapter({}),
  embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
});

async function ledger(): Promise<Map<string, string>> {
  return read(async (tx) => {
    const r = await tx.run(
      'MATCH (m:SchemaMigration) RETURN m.id AS id, toString(m.appliedAt) AS at',
    );
    return new Map(r.records.map((rec) => [rec.get('id') as string, rec.get('at') as string]));
  });
}

beforeAll(async () => {
  assertDestructiveAllowed();
  await write((tx) => tx.run('MATCH (n) DETACH DELETE n'));
  await migrate();
});

afterAll(async () => {
  await writeEmbeddingState(CONFIGURED);
  await shutdown();
});

describe('migration ledger', () => {
  test('records every migration once, and a second run applies nothing', async () => {
    const first = await ledger();
    expect([...first.keys()].sort()).toEqual(MIGRATIONS.map((m) => m.id).sort());

    await migrate();
    expect(await ledger()).toEqual(first);
  });

  test('runs a migration whose record is missing against old-shaped data', async () => {
    // A graph from before nameNorm has no constraint on it; the migration
    // must merge the duplicates first and then create it.
    await write((tx) => tx.run('DROP CONSTRAINT entity_name_norm IF EXISTS'));
    await write(async (tx) => {
      // Pre-v1.2 fact (no :MemoryItem) and two entities that differ only by
      // case and whitespace, written before nameNorm existed.
      await tx.run("CREATE (:Fact {id: 'old-fact', content: 'x'})");
      await tx.run(
        "CREATE (:Entity {id: 'e1', name: 'Alice'}), (:Entity {id: 'e2', name: 'alice '})",
      );
      await tx.run(
        `MATCH (m:SchemaMigration) WHERE m.id IN ['0001-memory-item-labels', '0002-entity-name-norm']
         DELETE m`,
      );
    });

    await migrate();

    const { kind, entities } = await read(async (tx) => {
      const f = await tx.run("MATCH (f:Fact:MemoryItem {id: 'old-fact'}) RETURN f.kind AS kind");
      const e = await tx.run("MATCH (e:Entity) WHERE e.nameNorm = 'alice' RETURN count(e) AS n");
      return { kind: f.records[0]?.get('kind'), entities: Number(e.records[0]?.get('n')) };
    });
    expect(kind).toBe('fact');
    expect(entities).toBe(1);
    const constraints = await read(async (tx) => {
      const r = await tx.run(
        "SHOW CONSTRAINTS YIELD name WHERE name = 'entity_name_norm' RETURN name",
      );
      return r.records.length;
    });
    expect(constraints).toBe(1);
    expect((await ledger()).size).toBe(MIGRATIONS.length);
  });
});

describe('embedding record', () => {
  test('migrate records the configured model and the index dimension', async () => {
    expect(await readEmbeddingState()).toEqual(CONFIGURED);
  });

  test('boot refuses when the stored model differs', async () => {
    await writeEmbeddingState({ ...CONFIGURED, embedModel: 'ollama:nomic-embed-text' });
    await expect(bootstrap(adapters())).rejects.toThrow(
      /model openai:text-embedding-3-large.*reembed/,
    );
  });

  test('boot refuses when the stored dimension differs', async () => {
    await writeEmbeddingState({ ...CONFIGURED, embedDim: EMBED_DIM * 2 });
    await expect(bootstrap(adapters())).rejects.toThrow(/EMBED_DIM/);
  });

  test('a mismatch never overwrites the record, and a match boots', async () => {
    await writeEmbeddingState({ ...CONFIGURED, embedModel: 'ollama:nomic-embed-text' });
    await migrate();
    expect((await readEmbeddingState())?.embedModel).toBe('ollama:nomic-embed-text');

    await writeEmbeddingState(CONFIGURED);
    const container = await bootstrap(adapters());
    const app = await buildHttpServer(container);
    const res = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    expect(res.json().data).toMatchObject({
      embedModel: CONFIGURED.embedModel,
      schemaEmbedModel: CONFIGURED.embedModel,
      schemaVectorDim: EMBED_DIM,
    });
  });
});
