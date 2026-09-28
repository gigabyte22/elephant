// Re-embed every stored vector with a new embedding model. The supported way
// to change MEMORY_EMBED_PROVIDER, the model, or EMBED_DIM on a graph that
// already has data; scripts/reembed.ts is the CLI.
//
// Each vector-bearing label is re-derived from the same text its writer
// embedded (see SOURCES). When the dimension changes, the vector indexes are
// dropped first and recreated at the new size afterwards, since an index only
// accepts vectors of its own dimension. The stored (:SystemState {key:
// 'embedding'}) record is updated last, so an interrupted run leaves boot
// refusing and is simply run again.

import type { EmbeddingAdapter } from './adapters/embeddings/types.ts';
import { read, write } from './config/neo4j.ts';
import { type EmbeddingState, readEmbeddingState, writeEmbeddingState } from './embedding-state.ts';
import { buildStatements, VECTOR_INDEX_LABELS } from './migrate.ts';
import { procedureEmbedText } from './services/ProcedureService.ts';
import { fitToTokenBudget } from './utils/tokens.ts';

type VectorLabel = (typeof VECTOR_INDEX_LABELS)[number];
type Row = Record<string, string | null>;

interface Source {
  fields: string[];
  text(row: Row): string;
}

const field =
  (name: string): Source['text'] =>
  (row) =>
    row[name] ?? '';

// What each label's writer passes to the embedder. Keyed by the full label
// list, so adding a vector label to migrate.ts fails the build until it is
// described here.
const SOURCES: Record<VectorLabel, Source> = {
  Fact: { fields: ['content'], text: field('content') },
  // Promoted from a fact and stored with that fact's vector.
  Insight: { fields: ['content'], text: field('content') },
  Preference: { fields: ['key', 'value'], text: (r) => `${r.key ?? ''}: ${r.value ?? ''}` },
  Observation: { fields: ['content'], text: field('content') },
  Episode: { fields: ['summary'], text: field('summary') },
  Chunk: { fields: ['text'], text: field('text') },
  KnowledgeDocument: { fields: ['summary'], text: field('summary') },
  KnowledgeChunk: { fields: ['text'], text: field('text') },
  Procedure: {
    fields: ['whenToUse', 'content'],
    text: (r) => procedureEmbedText(r.whenToUse ?? '', r.content ?? ''),
  },
  Research: { fields: ['summary'], text: field('summary') },
  ResearchChunk: { fields: ['text'], text: field('text') },
  Intention: { fields: ['content'], text: field('content') },
  // Entity resolution in the dream cycle embeds the entity by name.
  Entity: { fields: ['name'], text: field('name') },
};

export interface ReembedOptions {
  embedder: EmbeddingAdapter;
  /** `<provider>:<model>` to record, as embedModelId() spells it. */
  embedModel: string;
  /** EMBED_MAX_INPUT_TOKENS, when set; texts are clipped to the embedder's limit. */
  maxInputTokens?: number;
  batchSize?: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface ReembedReport {
  from: EmbeddingState | null;
  to: EmbeddingState;
  recreateIndexes: boolean;
  /** Nodes per label carrying a vector. After a real run, all were re-embedded. */
  counts: Partial<Record<VectorLabel, number>>;
  /** Nodes whose source text is empty: their vector is removed instead. */
  cleared: number;
}

async function countVectors(label: VectorLabel): Promise<number> {
  return read(async (tx) => {
    const r = await tx.run(`MATCH (n:${label}) WHERE n.embedding IS NOT NULL RETURN count(n) AS n`);
    return Number(r.records[0]?.get('n') ?? 0);
  });
}

async function setVectorIndexes(dim: number | null): Promise<void> {
  if (dim === null) {
    for (const label of VECTOR_INDEX_LABELS) {
      await write((tx) => tx.run(`DROP INDEX ${label.toLowerCase()}_vectors IF EXISTS`));
    }
    return;
  }
  for (const stmt of buildStatements(dim).filter((s) => s.name.startsWith('vector:'))) {
    await write((tx) => tx.run(stmt.cypher));
  }
  await write((tx) => tx.run('CALL db.awaitIndexes(300000)'));
}

export async function reembed(opts: ReembedOptions): Promise<ReembedReport> {
  const { embedder } = opts;
  const log = opts.log ?? (() => undefined);
  const batchSize = opts.batchSize ?? 64;
  const limit = Math.min(embedder.maxInputTokens, opts.maxInputTokens ?? Number.POSITIVE_INFINITY);

  // Trust the vectors, not the adapter's claim: a model served under the
  // wrong EMBED_DIM would otherwise be written into indexes it cannot match.
  const [probe] = await embedder.embedBatch(['dimension probe']);
  if (probe?.length !== embedder.dim) {
    throw new Error(
      `${embedder.name} returned a ${probe?.length ?? 0}-dim vector but is configured for ${embedder.dim}; fix EMBED_DIM first`,
    );
  }

  const from = await readEmbeddingState();
  const to = { embedModel: opts.embedModel, embedDim: embedder.dim };
  const recreateIndexes = from?.embedDim !== to.embedDim;
  const counts: ReembedReport['counts'] = {};
  for (const label of VECTOR_INDEX_LABELS) counts[label] = await countVectors(label);
  const report: ReembedReport = { from, to, recreateIndexes, counts, cleared: 0 };
  if (opts.dryRun) return report;

  if (recreateIndexes) {
    log('[reembed] dropping vector indexes (dimension changes)');
    await setVectorIndexes(null);
  }

  for (const label of VECTOR_INDEX_LABELS) {
    const { fields, text } = SOURCES[label];
    const projection = fields.map((f) => `n.${f} AS ${f}`).join(', ');
    let after = '';
    let done = 0;
    for (;;) {
      const rows = await read(async (tx) => {
        const r = await tx.run(
          `MATCH (n:${label}) WHERE n.embedding IS NOT NULL AND n.id > $after
           RETURN n.id AS id, ${projection}
           ORDER BY n.id LIMIT toInteger($limit)`,
          { after, limit: batchSize },
        );
        return r.records.map((rec) => rec.toObject() as Row & { id: string });
      });
      const last = rows.at(-1);
      if (!last) break;
      after = last.id;

      const texts = await Promise.all(
        rows.map((row) => fitToTokenBudget(text(row), limit, (t) => embedder.countTokens(t))),
      );
      const withText = rows.flatMap((row, i) => (texts[i] ? [{ id: row.id, text: texts[i] }] : []));
      const vectors = withText.length ? await embedder.embedBatch(withText.map((r) => r.text)) : [];
      const updates = withText.map((r, i) => ({ id: r.id, embedding: vectors[i] }));
      const empty = rows.filter((_, i) => !texts[i]).map((row) => row.id);

      await write(async (tx) => {
        await tx.run(
          `UNWIND $updates AS u MATCH (n:${label} {id: u.id}) SET n.embedding = u.embedding`,
          { updates },
        );
        await tx.run(`MATCH (n:${label}) WHERE n.id IN $empty REMOVE n.embedding`, { empty });
      });
      report.cleared += empty.length;
      done += rows.length;
    }
    if (done > 0) log(`[reembed] ${label}: ${done}`);
  }

  if (recreateIndexes) {
    log(`[reembed] recreating vector indexes at dim ${to.embedDim}`);
    await setVectorIndexes(to.embedDim);
  }
  await writeEmbeddingState(to);
  return report;
}
