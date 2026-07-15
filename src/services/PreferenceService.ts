import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import { read, write } from '../config/neo4j.ts';
import type { Preference } from '../models/types.ts';
import { PreferenceRepository } from '../repositories/PreferenceRepository.ts';
import { AuditService } from './AuditService.ts';

const PREFERENCE_ACTOR = 'preference-service';

interface Deps {
  embedder: EmbeddingAdapter;
}

export function createPreferenceService(deps: Deps) {
  const { embedder } = deps;

  async function get(key: string): Promise<Preference | null> {
    return read((tx) => PreferenceRepository.getActive(tx, key));
  }

  async function set(input: {
    key: string;
    value: string;
    confidence?: number;
  }): Promise<Preference> {
    const embedding = await embedder.embed(`${input.key}: ${input.value}`);
    return write(async (tx) => {
      const { next, prior } = await PreferenceRepository.set(tx, {
        key: input.key,
        value: input.value,
        confidence: input.confidence ?? 0.95,
        embedding,
        at: new Date(),
      });

      if (prior) {
        // Snapshot the prior value (revise) AND emit a 'supersede' event so
        // both the revision chain and the lifecycle log are intact.
        await AuditService.revise({
          tx,
          before: prior,
          kind: 'preference',
          reason: 'preference updated',
          actor: PREFERENCE_ACTOR,
          eventKind: 'supersede',
          payload: { key: input.key, newId: next.id, priorId: prior.id },
        });
      } else {
        await AuditService.record({
          tx,
          kind: 'create',
          targetId: next.id,
          targetKind: 'preference',
          actor: PREFERENCE_ACTOR,
          payload: { key: input.key },
        });
      }

      return next;
    });
  }

  async function listActive(): Promise<Preference[]> {
    return read((tx) => PreferenceRepository.listActive(tx));
  }

  return { get, set, listActive };
}

export type PreferenceService = ReturnType<typeof createPreferenceService>;
