// scripts/reembed.ts's engine against the testcontainer: a model and dimension
// change re-derives every vector from its source text, rebuilds the vector
// indexes at the new size, and moves the stored embedding record, which is what
// /health reports and what boot checks. afterAll re-embeds back to the suite's
// configuration so later specs find 256-dim indexes.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter } from '../../src/adapters/fakes.ts';
import { read, write } from '../../src/config/neo4j.ts';
import { readEmbeddingState, readVectorIndexDim } from '../../src/embedding-state.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { buildContainer, shutdown } from '../../src/index.ts';
import { migrate } from '../../src/migrate.ts';
import { reembed } from '../../src/reembed.ts';
import { assertDestructiveAllowed } from './guard.ts';

const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const SUITE_MODEL = 'openai:text-embedding-3-large';
const NEW_MODEL = 'fake:v2';
const NEW_DIM = 128;
const oldEmbedder = createFakeEmbeddingAdapter({ dim: EMBED_DIM });
const newEmbedder = createFakeEmbeddingAdapter({ dim: NEW_DIM });

async function embeddingOf(label: string, id: string): Promise<number[] | null> {
  return read(async (tx) => {
    const r = await tx.run(`MATCH (n:${label} {id: $id}) RETURN n.embedding AS e`, { id });
    return (r.records[0]?.get('e') as number[] | null) ?? null;
  });
}

beforeAll(async () => {
  assertDestructiveAllowed();
  await write((tx) => tx.run('MATCH (n) DETACH DELETE n'));
  await migrate();
  const vec = await oldEmbedder.embed('old model');
  await write((tx) =>
    tx.run(
      `CREATE (:Fact:MemoryItem {id: 'f1', kind: 'fact', content: 'the deploy runbook lives in the ops wiki', embedding: $vec})
       CREATE (:Entity {id: 'e1', name: 'ops wiki', nameNorm: 'ops wiki', embedding: $vec})
       CREATE (:Procedure:MemoryItem {id: 'p1', kind: 'procedure', name: 'deploy', whenToUse: 'shipping a release', content: 'run the pipeline', embedding: $vec})
       CREATE (:Episode:MemoryItem {id: 'ep1', kind: 'episode', summary: '', embedding: $vec})`,
      { vec },
    ),
  );
});

afterAll(async () => {
  await reembed({ embedder: oldEmbedder, embedModel: SUITE_MODEL });
  await shutdown();
});

describe('reembed', () => {
  test('a dry run reports the plan and writes nothing', async () => {
    const report = await reembed({ embedder: newEmbedder, embedModel: NEW_MODEL, dryRun: true });
    expect(report).toMatchObject({
      from: { embedModel: SUITE_MODEL, embedDim: EMBED_DIM },
      to: { embedModel: NEW_MODEL, embedDim: NEW_DIM },
      recreateIndexes: true,
      counts: { Fact: 1, Entity: 1, Procedure: 1, Episode: 1, Chunk: 0 },
    });
    expect(await embeddingOf('Fact', 'f1')).toHaveLength(EMBED_DIM);
    expect((await readEmbeddingState())?.embedModel).toBe(SUITE_MODEL);
  });

  test('re-embeds every vector from its source text at the new dimension', async () => {
    const report = await reembed({ embedder: newEmbedder, embedModel: NEW_MODEL, batchSize: 1 });
    expect(report.cleared).toBe(1);

    expect(await embeddingOf('Fact', 'f1')).toEqual(
      await newEmbedder.embed('the deploy runbook lives in the ops wiki'),
    );
    expect(await embeddingOf('Entity', 'e1')).toEqual(await newEmbedder.embed('ops wiki'));
    expect(await embeddingOf('Procedure', 'p1')).toEqual(
      await newEmbedder.embed('shipping a release\n\nrun the pipeline'),
    );
    // Nothing to embed: the stale vector is removed rather than left mismatched.
    expect(await embeddingOf('Episode', 'ep1')).toBeNull();

    expect(await readVectorIndexDim()).toBe(NEW_DIM);
    expect(await readEmbeddingState()).toEqual({ embedModel: NEW_MODEL, embedDim: NEW_DIM });
    const hit = await read(async (tx) => {
      const r = await tx.run(
        "CALL db.index.vector.queryNodes('fact_vectors', 1, $q) YIELD node RETURN node.id AS id",
        { q: await newEmbedder.embed('deploy runbook') },
      );
      return r.records[0]?.get('id');
    });
    expect(hit).toBe('f1');
  });

  test('/health reports the graph moving to the new model', async () => {
    const container = await buildContainer({ embedder: oldEmbedder });
    const app = await buildHttpServer(container);
    const res = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    expect(res.json().data).toMatchObject({
      embedModel: SUITE_MODEL,
      schemaEmbedModel: NEW_MODEL,
      schemaVectorDim: NEW_DIM,
    });
  });
});
