import type { ManagedTransaction } from 'neo4j-driver';
import type { Preference, Scope } from '../models/types.ts';
import { newId } from '../utils/ids.ts';
import { dateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import { memoryItemParams, memoryItemSetClause, readScope } from './scope.ts';

function toPreference(node: Record<string, unknown>): Preference {
  return {
    id: node.id as string,
    key: node.key as string,
    value: node.value as string,
    confidence: node.confidence as number,
    validFrom: toJsDate(node.validFrom),
    validTo: toJsDateOrNull(node.validTo),
    embedding: (node.embedding as number[]) ?? [],
    ...readScope(node),
  };
}

export const PreferenceRepository = {
  async getActive(tx: ManagedTransaction, key: string): Promise<Preference | null> {
    const result = await tx.run(
      `MATCH (p:Preference {key: $key})
       WHERE p.validTo IS NULL
       RETURN p {.*} AS p
       LIMIT 1`,
      { key },
    );
    const record = result.records[0];
    return record ? toPreference(record.get('p')) : null;
  },

  // Atomically: close out the prior active version (if any), insert a new versioned
  // node, link them with :SUPERSEDES. Returns the new preference alongside the
  // prior version (pre-`validTo` mutation) so callers can audit the transition.
  async set(
    tx: ManagedTransaction,
    input: {
      key: string;
      value: string;
      confidence: number;
      embedding: number[];
      at: Date;
      scope?: Scope;
    },
  ): Promise<{ next: Preference; prior: Preference | null }> {
    const result = await tx.run(
      `OPTIONAL MATCH (oldP:Preference {key: $key}) WHERE oldP.validTo IS NULL
       WITH oldP, oldP {.*} AS priorSnapshot
       CREATE (newP:Preference {
         id: $newId,
         key: $key,
         value: $value,
         confidence: $confidence,
         embedding: $embedding,
         validFrom: datetime($at),
         validTo: NULL
       })
       SET ${memoryItemSetClause('newP')}
       FOREACH (_ IN CASE WHEN oldP IS NULL THEN [] ELSE [1] END |
         SET oldP.validTo = datetime($at)
         MERGE (newP)-[r:SUPERSEDES]->(oldP)
         SET r.supersededAt = datetime($at)
       )
       RETURN newP {.*} AS p, priorSnapshot`,
      {
        newId: newId(),
        key: input.key,
        value: input.value,
        confidence: input.confidence,
        embedding: input.embedding,
        at: dateParam(input.at),
        ...memoryItemParams('preference', input.scope ?? {}),
      },
    );
    const record = result.records[0]!;
    const priorRaw = record.get('priorSnapshot') as Record<string, unknown> | null;
    return {
      next: toPreference(record.get('p')),
      prior: priorRaw ? toPreference(priorRaw) : null,
    };
  },

  async listActive(tx: ManagedTransaction): Promise<Preference[]> {
    const result = await tx.run(
      `MATCH (p:Preference) WHERE p.validTo IS NULL
       RETURN p {.*} AS p
       ORDER BY p.key`,
    );
    return result.records.map((r) => toPreference(r.get('p')));
  },

  async snapshotAt(
    tx: ManagedTransaction,
    input: { key: string; at: Date },
  ): Promise<Preference | null> {
    const result = await tx.run(
      `MATCH (p:Preference {key: $key})
       WHERE p.validFrom <= datetime($at)
         AND (p.validTo IS NULL OR p.validTo > datetime($at))
       RETURN p {.*} AS p
       LIMIT 1`,
      { key: input.key, at: dateParam(input.at) },
    );
    const record = result.records[0];
    return record ? toPreference(record.get('p')) : null;
  },

  async listSimilar(
    tx: ManagedTransaction,
    input: {
      embedding: number[];
      limit: number;
      minScore?: number;
      includeSuperseded?: boolean;
    },
  ): Promise<Array<Preference & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const includeSuperseded = input.includeSuperseded ?? false;
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('preference_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore
       ${includeSuperseded ? '' : 'AND node.validTo IS NULL'}
       RETURN node {.*} AS p, score
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore },
    );
    return result.records.map((r) => ({
      ...toPreference(r.get('p')),
      score: r.get('score') as number,
    }));
  },
};
