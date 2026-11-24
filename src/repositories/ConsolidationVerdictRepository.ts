import type { ManagedTransaction } from 'neo4j-driver';
import { dateParam } from '../utils/neo4j-conv.ts';

// A consolidation judgement that did not produce a merge, remembered so the
// dreamer does not send the same cluster to the model every night.
//
// `key` is the sha256 of the cluster's sorted member fact ids (see
// consolidationClusterKey in DreamingService), so a cluster that gains or loses
// a fact is a different key and is judged again. `outcome` says why nothing
// merged: 'keep' (the model said keep separate) or 'rejected_merge' (the model
// proposed a merge that failed validation).
export type ConsolidationVerdictOutcome = 'keep' | 'rejected_merge';

export const ConsolidationVerdictRepository = {
  async record(
    tx: ManagedTransaction,
    input: { key: string; factIds: string[]; outcome: ConsolidationVerdictOutcome; at: Date },
  ): Promise<void> {
    await tx.run(
      `MERGE (v:ConsolidationVerdict {key: $key})
       SET v.factIds = $factIds,
           v.outcome = $outcome,
           v.decidedAt = datetime($at)`,
      {
        key: input.key,
        factIds: [...input.factIds].sort(),
        outcome: input.outcome,
        at: dateParam(input.at),
      },
    );
  },

  // Which of `keys` carry a verdict decided at or after `since`.
  async listFresh(tx: ManagedTransaction, keys: string[], since: Date): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const result = await tx.run(
      `UNWIND $keys AS k
       MATCH (v:ConsolidationVerdict {key: k})
       WHERE v.decidedAt >= datetime($since)
       RETURN v.key AS key`,
      { keys, since: dateParam(since) },
    );
    return new Set(result.records.map((r) => r.get('key') as string));
  },

  // Verdicts past the rejudge window no longer skip anything; drop them so the
  // label does not grow without bound. Returns the number removed.
  async deleteOlderThan(tx: ManagedTransaction, cutoff: Date): Promise<number> {
    const result = await tx.run(
      `MATCH (v:ConsolidationVerdict)
       WHERE v.decidedAt < datetime($cutoff)
       DELETE v
       RETURN count(*) AS n`,
      { cutoff: dateParam(cutoff) },
    );
    return Number(result.records[0]?.get('n') ?? 0);
  },
};
