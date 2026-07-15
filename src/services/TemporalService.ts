import { read } from '../config/neo4j.ts';
import type { Fact, Preference } from '../models/types.ts';
import { FactRepository } from '../repositories/FactRepository.ts';
import { PreferenceRepository } from '../repositories/PreferenceRepository.ts';

export interface SnapshotInput {
  at: Date;
  entityId?: string;
  preferenceKey?: string;
  limit?: number;
}

export interface SnapshotResult {
  facts: Fact[];
  preference?: Preference | null;
}

export function createTemporalService() {
  async function snapshotAt(input: SnapshotInput): Promise<SnapshotResult> {
    return read(async (tx) => {
      const facts = await FactRepository.snapshotAt(tx, {
        at: input.at,
        entityId: input.entityId,
        limit: input.limit ?? 100,
      });
      const preference = input.preferenceKey
        ? await PreferenceRepository.snapshotAt(tx, {
            key: input.preferenceKey,
            at: input.at,
          })
        : undefined;
      return { facts, preference };
    });
  }

  return { snapshotAt };
}

export type TemporalService = ReturnType<typeof createTemporalService>;
