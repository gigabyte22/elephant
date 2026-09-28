// Which embedding model and dimension the stored vectors were made with.
//
// Kept on (:SystemState {key: 'embedding'}), written by `migrate()` the first
// time it meets a graph and afterwards only by scripts/reembed.ts. Boot compares
// it with the configured embedder and refuses on any difference: a different
// dimension breaks every vector index, and a different model at the same
// dimension is worse — its vectors are silently incomparable with the stored
// ones, so recall degrades with no error anywhere.

import { embedModelId } from './adapters/factory.ts';
import type { Env } from './config/env.ts';
import { read, write } from './config/neo4j.ts';

export interface EmbeddingState {
  embedModel: string;
  embedDim: number;
}

export function configuredEmbedding(env: Env): EmbeddingState {
  return { embedModel: embedModelId(env), embedDim: env.EMBED_DIM };
}

export async function readEmbeddingState(): Promise<EmbeddingState | null> {
  return read(async (tx) => {
    const r = await tx.run(
      "MATCH (s:SystemState {key: 'embedding'}) RETURN s.embedModel AS model, s.embedDim AS dim",
    );
    const row = r.records[0];
    if (!row) return null;
    return { embedModel: row.get('model') as string, embedDim: Number(row.get('dim')) };
  });
}

export async function writeEmbeddingState(state: EmbeddingState): Promise<void> {
  await write((tx) =>
    tx.run(
      `MERGE (s:SystemState {key: 'embedding'})
       SET s.embedModel = $embedModel, s.embedDim = toInteger($embedDim), s.updatedAt = datetime()`,
      { ...state },
    ),
  );
}

/** Dimension of the fact vector index, or null when it does not exist yet. */
export async function readVectorIndexDim(): Promise<number | null> {
  return read(async (tx) => {
    const r = await tx.run(
      "SHOW VECTOR INDEX YIELD name, options WHERE name = 'fact_vectors' RETURN options",
    );
    const options = r.records[0]?.get('options') as
      | { indexConfig?: Record<string, unknown> }
      | undefined;
    const dim = options?.indexConfig?.['vector.dimensions'];
    return typeof dim === 'number' ? dim : null;
  });
}

/** A human-readable reason the configured embedder cannot use the stored vectors, or null. */
export function describeEmbeddingMismatch(
  configured: EmbeddingState,
  stored: EmbeddingState,
): string | null {
  const diffs: string[] = [];
  if (configured.embedModel !== stored.embedModel) {
    diffs.push(`model ${configured.embedModel} (graph has ${stored.embedModel})`);
  }
  if (configured.embedDim !== stored.embedDim) {
    diffs.push(`EMBED_DIM ${configured.embedDim} (graph has ${stored.embedDim})`);
  }
  if (diffs.length === 0) return null;
  return (
    `The configured embedder does not match the stored vectors: ${diffs.join(', ')}. ` +
    'Either restore the previous embedding settings, or re-embed the graph with the new ' +
    'ones: `pnpm reembed` (scripts/reembed.ts; --dry-run first).'
  );
}

/** Throws when the graph's vectors were made with a different model or dimension. */
export async function assertEmbeddingMatchesGraph(env: Env): Promise<void> {
  const stored = await readEmbeddingState();
  // Nothing recorded yet: a graph `migrate()` has not seen since this check
  // existed. It records the state on its next run.
  if (!stored) return;
  const mismatch = describeEmbeddingMismatch(configuredEmbedding(env), stored);
  if (mismatch) throw new Error(mismatch);
}
