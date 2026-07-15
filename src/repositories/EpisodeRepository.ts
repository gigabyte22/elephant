import type { ManagedTransaction } from 'neo4j-driver';
import type { Episode, EpisodeOrigin } from '../models/types.ts';
import { dateParam, toJsDate } from '../utils/neo4j-conv.ts';
import { memoryItemParams, memoryItemSetClause, readScope } from './scope.ts';

function toEpisode(node: Record<string, unknown>): Episode {
  return {
    id: node.id as string,
    agentId: node.agentId as string,
    sessionId: node.sessionId as string,
    timestamp: toJsDate(node.timestamp),
    rawTranscript: node.rawTranscript as string,
    summary: node.summary as string,
    embedding: (node.embedding as number[]) ?? [],
    origin: (node.origin as EpisodeOrigin | undefined) ?? undefined,
    isolated: (node.isolated as boolean | undefined) ?? undefined,
    ...readScope(node),
  };
}

export const EpisodeRepository = {
  async create(tx: ManagedTransaction, ep: Episode): Promise<Episode> {
    const result = await tx.run(
      `MERGE (e:Episode {id: $id})
       SET ${memoryItemSetClause('e')},
           e.agentId = $agentId,
           e.sessionId = $sessionId,
           e.timestamp = datetime($timestamp),
           e.rawTranscript = $rawTranscript,
           e.summary = $summary,
           e.embedding = $embedding,
           e.origin = $origin,
           e.isolated = $isolated
       RETURN e {.*} AS e`,
      {
        id: ep.id,
        agentId: ep.agentId,
        sessionId: ep.sessionId,
        timestamp: dateParam(ep.timestamp),
        rawTranscript: ep.rawTranscript,
        summary: ep.summary,
        embedding: ep.embedding,
        origin: ep.origin ?? null,
        isolated: ep.isolated ?? null,
        ...memoryItemParams('episode', ep),
      },
    );
    return toEpisode(result.records[0]!.get('e'));
  },

  async get(tx: ManagedTransaction, id: string): Promise<Episode | null> {
    const result = await tx.run('MATCH (e:Episode {id: $id}) RETURN e {.*} AS e', { id });
    const record = result.records[0];
    return record ? toEpisode(record.get('e')) : null;
  },

  async listSince(tx: ManagedTransaction, since: Date): Promise<Episode[]> {
    const result = await tx.run(
      `MATCH (e:Episode)
       WHERE e.timestamp >= datetime($since)
       RETURN e {.*} AS e
       ORDER BY e.timestamp ASC`,
      { since: dateParam(since) },
    );
    return result.records.map((r) => toEpisode(r.get('e')));
  },

  // `since` is exclusive — the dream cursor points at the last-processed
  // timestamp, so we want strictly-greater to avoid re-processing.
  async listAfterLimit(
    tx: ManagedTransaction,
    input: { after: Date; limit: number },
  ): Promise<Episode[]> {
    const result = await tx.run(
      `MATCH (e:Episode)
       WHERE e.timestamp > datetime($after)
       RETURN e {.*} AS e
       ORDER BY e.timestamp ASC
       LIMIT toInteger($limit)`,
      { after: dateParam(input.after), limit: input.limit },
    );
    return result.records.map((r) => toEpisode(r.get('e')));
  },

  async countAfter(tx: ManagedTransaction, after: Date): Promise<number> {
    const result = await tx.run(
      `MATCH (e:Episode)
       WHERE e.timestamp > datetime($after)
       RETURN count(e) AS n`,
      { after: dateParam(after) },
    );
    // Driver runs with disableLosslessIntegers=true, so count() is a JS number.
    return (result.records[0]?.get('n') as number) ?? 0;
  },

  // Batched lookup of just the scoping metadata for a set of episodes.
  // Retrieval uses this to stamp originAgentId/originSessionId on fact candidates
  // without hydrating full Episode records.
  async getManyMeta(
    tx: ManagedTransaction,
    ids: string[],
  ): Promise<Map<string, { agentId: string; sessionId: string }>> {
    if (ids.length === 0) return new Map();
    const result = await tx.run(
      `UNWIND $ids AS id
       MATCH (e:Episode {id: id})
       RETURN e.id AS id, e.agentId AS agentId, e.sessionId AS sessionId`,
      { ids },
    );
    const out = new Map<string, { agentId: string; sessionId: string }>();
    for (const r of result.records) {
      out.set(r.get('id') as string, {
        agentId: r.get('agentId') as string,
        sessionId: r.get('sessionId') as string,
      });
    }
    return out;
  },
};
