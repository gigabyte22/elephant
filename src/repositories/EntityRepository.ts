import type { ManagedTransaction } from 'neo4j-driver';
import type { Entity } from '../models/types.ts';
import { newId } from '../utils/ids.ts';

function toEntity(node: Record<string, unknown>): Entity {
  return {
    id: node.id as string,
    name: node.name as string,
    type: node.type as string,
    embedding: (node.embedding as number[]) ?? [],
  };
}

interface UpsertInput {
  name: string;
  type: string;
  embedding: number[];
}

// Canonical identity key for an entity. Folding case + surrounding whitespace
// stops "Alice", "alice", and "Alice " from splintering into three nodes — the
// merge key the graph dedups on, while `name` keeps the first-seen display form.
// Lookup (`fuzzyFindByName`) already lowercases, so storage and retrieval agree.
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export const EntityRepository = {
  async upsertByName(tx: ManagedTransaction, input: UpsertInput): Promise<Entity> {
    const result = await tx.run(
      `MERGE (e:Entity {nameNorm: $nameNorm})
       ON CREATE SET e.id = $id, e.name = $name, e.type = $type, e.embedding = $embedding
       ON MATCH SET e.type = coalesce(e.type, $type)
       RETURN e {.*} AS e`,
      {
        id: newId(),
        name: input.name,
        nameNorm: normalizeName(input.name),
        type: input.type,
        embedding: input.embedding,
      },
    );
    return toEntity(result.records[0]!.get('e'));
  },

  // Batched upsert via UNWIND. Avoids N round-trips when an extraction yields
  // many entities. Each row carries its own candidate id / type / embedding so
  // new entities get them; existing entities keep theirs (type is coalesced,
  // embedding is untouched on match). Merge is on the normalized name so
  // case/whitespace variants collapse onto one node — even within one batch,
  // since UNWIND MERGE sees prior writes in the same statement.
  async upsertMany(tx: ManagedTransaction, inputs: UpsertInput[]): Promise<Entity[]> {
    if (inputs.length === 0) return [];
    const rows = inputs.map((i) => ({
      id: newId(),
      name: i.name,
      nameNorm: normalizeName(i.name),
      type: i.type,
      embedding: i.embedding,
    }));
    const result = await tx.run(
      `UNWIND $rows AS r
       MERGE (e:Entity {nameNorm: r.nameNorm})
       ON CREATE SET e.id = r.id, e.name = r.name, e.type = r.type, e.embedding = r.embedding
       ON MATCH SET e.type = coalesce(e.type, r.type)
       RETURN e {.*} AS e, r.nameNorm AS requestedNorm`,
      { rows },
    );
    // Preserve input order so callers can zip back to their source.
    const byNorm = new Map<string, Entity>();
    for (const rec of result.records) {
      byNorm.set(rec.get('requestedNorm') as string, toEntity(rec.get('e')));
    }
    return inputs.map((i) => {
      const e = byNorm.get(normalizeName(i.name));
      if (!e) throw new Error(`upsertMany: entity '${i.name}' missing from result`);
      return e;
    });
  },

  async get(tx: ManagedTransaction, id: string): Promise<Entity | null> {
    const result = await tx.run('MATCH (e:Entity {id: $id}) RETURN e {.*} AS e', { id });
    const record = result.records[0];
    return record ? toEntity(record.get('e')) : null;
  },

  // Batched lookup — replaces the per-id loop in the HydrateEntitiesStage.
  async getMany(tx: ManagedTransaction, ids: string[]): Promise<Entity[]> {
    if (ids.length === 0) return [];
    const result = await tx.run('UNWIND $ids AS id MATCH (e:Entity {id: id}) RETURN e {.*} AS e', {
      ids,
    });
    return result.records.map((r) => toEntity(r.get('e')));
  },

  async fuzzyFindByName(tx: ManagedTransaction, name: string, limit = 10): Promise<Entity[]> {
    // CONTAINS is fine here — the entity_name TEXT index supports this with reasonable perf.
    const result = await tx.run(
      `MATCH (e:Entity)
       WHERE toLower(e.name) CONTAINS toLower($name)
       RETURN e {.*} AS e
       LIMIT toInteger($limit)`,
      { name, limit },
    );
    return result.records.map((r) => toEntity(r.get('e')));
  },

  // --- Knowledge-graph edges (dream cycle) ---------------------------------

  // Upsert directed (subject)-[:RELATES {predicate}]->(object) triples. Caller
  // resolves entity names to ids first. MERGE on (s, predicate, o) dedupes; a
  // repeated extraction only bumps confidence. Returns the number of NEW edges.
  async upsertRelations(
    tx: ManagedTransaction,
    rows: Array<{
      subjectId: string;
      objectId: string;
      predicate: string;
      confidence: number;
      episodeId?: string;
    }>,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await tx.run(
      `UNWIND $rows AS r
       MATCH (s:Entity {id: r.subjectId})
       MATCH (o:Entity {id: r.objectId})
       WHERE s.id <> o.id
       MERGE (s)-[rel:RELATES {predicate: r.predicate}]->(o)
         ON CREATE SET rel.confidence = r.confidence,
                       rel.episodeId = r.episodeId,
                       rel.createdAt = datetime()
         ON MATCH SET rel.confidence =
           CASE WHEN r.confidence > rel.confidence THEN r.confidence ELSE rel.confidence END`,
      { rows: rows.map((r) => ({ ...r, episodeId: r.episodeId ?? null })) },
    );
    return result.summary.counters.updates().relationshipsCreated;
  },

  // Upsert non-destructive (:Entity)-[:SYNONYM {score}]->(:Entity) alias edges.
  // Canonicalised on id order so each pair yields one edge regardless of call
  // direction. Returns the number of NEW edges.
  async addSynonyms(
    tx: ManagedTransaction,
    pairs: Array<{ aId: string; bId: string; score: number }>,
  ): Promise<number> {
    if (pairs.length === 0) return 0;
    const result = await tx.run(
      `UNWIND $pairs AS p
       MATCH (a:Entity {id: p.aId}), (b:Entity {id: p.bId})
       WHERE a.id <> b.id
       WITH p,
            (CASE WHEN a.id < b.id THEN a ELSE b END) AS lo,
            (CASE WHEN a.id < b.id THEN b ELSE a END) AS hi
       MERGE (lo)-[s:SYNONYM]->(hi)
         ON CREATE SET s.score = p.score, s.createdAt = datetime()
         ON MATCH SET s.score = CASE WHEN p.score > s.score THEN p.score ELSE s.score END`,
      { pairs },
    );
    return result.summary.counters.updates().relationshipsCreated;
  },

  // Vector-similar entities to a seed, for synonym detection. Uses the
  // entity_vectors index; excludes the seed itself and anything under threshold.
  async findSynonymCandidates(
    tx: ManagedTransaction,
    input: { entityId: string; embedding: number[]; threshold: number; limit: number },
  ): Promise<Array<{ id: string; score: number }>> {
    if (input.embedding.length === 0) return [];
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('entity_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE node.id <> $entityId AND score >= $threshold
       RETURN node.id AS id, score
       ORDER BY score DESC`,
      {
        vec: input.embedding,
        limit: input.limit,
        entityId: input.entityId,
        threshold: input.threshold,
      },
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      score: r.get('score') as number,
    }));
  },

  // Batch-update entity embeddings. The dream cycle re-derives these from the
  // entity NAME (not the first fact's embedding) so they actually represent the
  // entity — fixing the write-once placeholder set at upsert time.
  async setEmbeddings(
    tx: ManagedTransaction,
    rows: Array<{ id: string; embedding: number[] }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.run('UNWIND $rows AS r MATCH (e:Entity {id: r.id}) SET e.embedding = r.embedding', {
      rows,
    });
  },

  // Link a query to entity ids by vector similarity over entity_vectors. These
  // become PageRank seeds (HippoRAG query→graph linking). Top-K by cosine; a
  // small floor keeps obviously-unrelated entities out of the seed set.
  async linkQueryEntities(
    tx: ManagedTransaction,
    input: { embedding: number[]; limit: number; minScore?: number },
  ): Promise<string[]> {
    if (input.embedding.length === 0) return [];
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('entity_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore
       RETURN node.id AS id
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore: input.minScore ?? 0 },
    );
    return result.records.map((r) => r.get('id') as string);
  },
};
