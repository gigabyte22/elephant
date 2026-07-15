import type { ManagedTransaction } from 'neo4j-driver';
import type { Chunk } from '../models/types.ts';
import { dateParam, toJsDate } from '../utils/neo4j-conv.ts';
import { readScope } from './scope.ts';

function toChunk(node: Record<string, unknown>): Chunk {
  return {
    id: node.id as string,
    episodeId: node.episodeId as string,
    position: node.position as number,
    text: node.text as string,
    tokenCount: node.tokenCount as number,
    embedding: (node.embedding as number[]) ?? [],
    createdAt: toJsDate(node.createdAt),
    ...readScope(node),
  };
}

export const ChunkRepository = {
  // Create all chunks of a single Episode atomically. Also links them:
  //   (Episode)-[:HAS_CHUNK {position}]->(Chunk)
  //   (Chunk)-[:NEXT]->(Chunk)    for adjacent positions
  async createForEpisode(
    tx: ManagedTransaction,
    input: { episodeId: string; chunks: Chunk[] },
  ): Promise<void> {
    if (input.chunks.length === 0) return;

    // Single UNWIND for the Chunk nodes themselves — one round trip for N chunks.
    await tx.run(
      `MATCH (ep:Episode {id: $episodeId})
       UNWIND $chunks AS c
       MERGE (ch:Chunk {id: c.id})
       SET ch:MemoryItem,
           ch.kind = 'chunk',
           ch.episodeId = $episodeId,
           ch.position = c.position,
           ch.text = c.text,
           ch.tokenCount = c.tokenCount,
           ch.embedding = c.embedding,
           ch.createdAt = datetime(c.createdAt),
           ch.projectId = c.projectId,
           ch.userId = c.userId
       MERGE (ep)-[r:HAS_CHUNK]->(ch)
       SET r.position = c.position`,
      {
        episodeId: input.episodeId,
        chunks: input.chunks.map((c) => ({
          id: c.id,
          position: c.position,
          text: c.text,
          tokenCount: c.tokenCount,
          embedding: c.embedding,
          createdAt: dateParam(c.createdAt),
          projectId: c.projectId ?? null,
          userId: c.userId ?? null,
        })),
      },
    );

    // NEXT chain: link position i to position i+1. One statement with UNWIND
    // of id pairs.
    if (input.chunks.length > 1) {
      const ordered = input.chunks.slice().sort((a, b) => a.position - b.position);
      const pairs = ordered.slice(0, -1).map((c, i) => ({ from: c.id, to: ordered[i + 1]!.id }));
      await tx.run(
        `UNWIND $pairs AS p
         MATCH (a:Chunk {id: p.from}), (b:Chunk {id: p.to})
         MERGE (a)-[:NEXT]->(b)`,
        { pairs },
      );
    }
  },

  async listByEpisode(tx: ManagedTransaction, episodeId: string): Promise<Chunk[]> {
    const result = await tx.run(
      `MATCH (ep:Episode {id: $episodeId})-[:HAS_CHUNK]->(c:Chunk)
       RETURN c {.*} AS c
       ORDER BY c.position ASC`,
      { episodeId },
    );
    return result.records.map((r) => toChunk(r.get('c')));
  },

  async get(tx: ManagedTransaction, id: string): Promise<Chunk | null> {
    const result = await tx.run('MATCH (c:Chunk {id: $id}) RETURN c {.*} AS c', { id });
    const record = result.records[0];
    return record ? toChunk(record.get('c')) : null;
  },

  async getMany(tx: ManagedTransaction, ids: string[]): Promise<Chunk[]> {
    if (ids.length === 0) return [];
    const result = await tx.run('UNWIND $ids AS id MATCH (c:Chunk {id: id}) RETURN c {.*} AS c', {
      ids,
    });
    return result.records.map((r) => toChunk(r.get('c')));
  },

  async listSimilar(
    tx: ManagedTransaction,
    input: { embedding: number[]; limit: number; minScore?: number },
  ): Promise<Array<Chunk & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('chunk_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore
       RETURN node {.*} AS c, score
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore },
    );
    return result.records.map((r) => ({
      ...toChunk(r.get('c')),
      score: r.get('score') as number,
    }));
  },

  async fullTextSearch(
    tx: ManagedTransaction,
    input: { query: string; limit: number },
  ): Promise<Array<Chunk & { score: number }>> {
    const result = await tx.run(
      `CALL db.index.fulltext.queryNodes('chunk_fulltext', $q) YIELD node, score
       WHERE node:Chunk
       RETURN node {.*} AS c, score
       ORDER BY score DESC
       LIMIT toInteger($limit)`,
      { q: input.query, limit: input.limit },
    );
    return result.records.map((r) => ({
      ...toChunk(r.get('c')),
      score: r.get('score') as number,
    }));
  },

  // :NEXT neighbours within an Episode, ±radius hops, deduped.
  // Radius is inlined because Cypher doesn't parameterise variable-length path
  // bounds. Callers are expected to pass a bounded radius ([1,3]).
  async neighbors(
    tx: ManagedTransaction,
    input: { chunkIds: string[]; radius: number },
  ): Promise<Chunk[]> {
    if (input.chunkIds.length === 0) return [];
    const radius = Math.max(1, Math.min(3, Math.trunc(input.radius)));
    const result = await tx.run(
      `UNWIND $chunkIds AS seedId
       MATCH (seed:Chunk {id: seedId})
       OPTIONAL MATCH (seed)-[:NEXT*1..${radius}]->(fwd:Chunk)
       OPTIONAL MATCH (back:Chunk)-[:NEXT*1..${radius}]->(seed)
       WITH collect(DISTINCT fwd) + collect(DISTINCT back) AS ns
       UNWIND ns AS n
       WITH DISTINCT n WHERE n IS NOT NULL
       RETURN n {.*} AS c`,
      { chunkIds: input.chunkIds },
    );
    return result.records.map((r) => toChunk(r.get('c')));
  },
};
