import type { ManagedTransaction } from 'neo4j-driver';
import type { Preference, Scope } from '../models/types.ts';
import { newId } from '../utils/ids.ts';
import { dateParam, nullableDateParam, toJsDate, toJsDateOrNull } from '../utils/neo4j-conv.ts';
import { validAtClause } from '../utils/temporal.ts';
import { memoryItemParams, memoryItemSetClause, readScope } from './scope.ts';

function toPreference(node: Record<string, unknown>): Preference {
  const validFrom = toJsDate(node.validFrom);
  // Pre-bitemporal rows lack recordedAt; treat validFrom as txn time fallback.
  const recordedAt = node.recordedAt != null ? toJsDate(node.recordedAt) : validFrom;
  return {
    id: node.id as string,
    key: node.key as string,
    value: node.value as string,
    confidence: node.confidence as number,
    validFrom,
    validTo: toJsDateOrNull(node.validTo),
    recordedAt,
    embedding: (node.embedding as number[]) ?? [],
    ...readScope(node),
  };
}

// A preference is identified by (key, projectId, userId), not by key alone.
// Keying on the bare key made every preference a global singleton: a PUT from
// one project superseded another project's value and emitted a supersede audit
// event against it. Nulls are part of the identity — the unscoped preference is
// its own row, not a wildcard.
// Null-safe equality. `p.projectId = $projectId` is NULL (not true) when both
// sides are null, so plain equality would make every UNSCOPED preference
// invisible — nulls are part of the identity here, not a wildcard.
const SCOPE_MATCH =
  '(p.projectId = $projectId OR (p.projectId IS NULL AND $projectId IS NULL)) ' +
  'AND (p.userId = $userId OR (p.userId IS NULL AND $userId IS NULL))';

function scopeParams(scope: Scope = {}): { projectId: string | null; userId: string | null } {
  return { projectId: scope.projectId ?? null, userId: scope.userId ?? null };
}

export const PreferenceRepository = {
  async getActive(
    tx: ManagedTransaction,
    key: string,
    scope: Scope = {},
  ): Promise<Preference | null> {
    const result = await tx.run(
      `MATCH (p:Preference {key: $key})
       WHERE p.validTo IS NULL AND ${SCOPE_MATCH}
       RETURN p {.*} AS p
       LIMIT 1`,
      { key, ...scopeParams(scope) },
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
      // Event/valid-time start of this version (and end of the prior, if any).
      validFrom: Date;
      // Transaction time for this write.
      recordedAt: Date;
      scope?: Scope;
    },
  ): Promise<{ next: Preference; prior: Preference | null }> {
    const result = await tx.run(
      `OPTIONAL MATCH (oldP:Preference {key: $key})
       WHERE oldP.validTo IS NULL
         AND (oldP.projectId = $projectId OR (oldP.projectId IS NULL AND $projectId IS NULL))
         AND (oldP.userId = $userId OR (oldP.userId IS NULL AND $userId IS NULL))
       WITH oldP, oldP {.*} AS priorSnapshot
       CREATE (newP:Preference {
         id: $newId,
         key: $key,
         value: $value,
         confidence: $confidence,
         embedding: $embedding,
         validFrom: datetime($validFrom),
         validTo: NULL,
         recordedAt: datetime($recordedAt)
       })
       SET ${memoryItemSetClause('newP')}
       FOREACH (_ IN CASE WHEN oldP IS NULL THEN [] ELSE [1] END |
         SET oldP.validTo = datetime($validFrom)
         MERGE (newP)-[r:SUPERSEDES]->(oldP)
         SET r.supersededAt = datetime($recordedAt)
       )
       RETURN newP {.*} AS p, priorSnapshot`,
      {
        newId: newId(),
        key: input.key,
        value: input.value,
        confidence: input.confidence,
        embedding: input.embedding,
        validFrom: dateParam(input.validFrom),
        recordedAt: dateParam(input.recordedAt),
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

  async listActive(tx: ManagedTransaction, scope: Scope = {}): Promise<Preference[]> {
    const result = await tx.run(
      `MATCH (p:Preference) WHERE p.validTo IS NULL AND ${SCOPE_MATCH}
       RETURN p {.*} AS p
       ORDER BY p.key`,
      scopeParams(scope),
    );
    return result.records.map((r) => toPreference(r.get('p')));
  },

  async snapshotAt(
    tx: ManagedTransaction,
    input: { key: string; at: Date; scope?: Scope },
  ): Promise<Preference | null> {
    const result = await tx.run(
      `MATCH (p:Preference {key: $key})
       WHERE p.validFrom <= datetime($at)
         AND (p.validTo IS NULL OR p.validTo > datetime($at))
         AND ${SCOPE_MATCH}
       RETURN p {.*} AS p
       LIMIT 1`,
      { key: input.key, at: dateParam(input.at), ...scopeParams(input.scope) },
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
      // Same valid-time as-of contract as FactRepository.listSimilar: keep only
      // the preference version whose interval covers this instant, so a
      // historical recall doesn't mix today's values in with older facts.
      asOf?: Date | null;
    },
  ): Promise<Array<Preference & { score: number }>> {
    const minScore = input.minScore ?? 0;
    const includeSuperseded = input.includeSuperseded ?? false;
    const asOf = input.asOf ?? null;
    const result = await tx.run(
      `CALL db.index.vector.queryNodes('preference_vectors', toInteger($limit), $vec) YIELD node, score
       WHERE score >= $minScore
       ${validAtClause('node', { asOf, includeSuperseded })}
       RETURN node {.*} AS p, score
       ORDER BY score DESC`,
      { vec: input.embedding, limit: input.limit, minScore, asOf: nullableDateParam(asOf) },
    );
    return result.records.map((r) => ({
      ...toPreference(r.get('p')),
      score: r.get('score') as number,
    }));
  },
};
