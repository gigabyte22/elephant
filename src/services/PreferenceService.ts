import type { EmbeddingAdapter } from '../adapters/embeddings/types.ts';
import { read, write } from '../config/neo4j.ts';
import type { Preference, Scope } from '../models/types.ts';
import { PreferenceRepository } from '../repositories/PreferenceRepository.ts';
import { AsyncMutex } from '../utils/AsyncMutex.ts';
import { AuditService } from './AuditService.ts';

const PREFERENCE_ACTOR = 'preference-service';

interface Deps {
  embedder: EmbeddingAdapter;
}

// Identity of a preference version.
function scopeKey(key: string, scope: Scope): string {
  return `${scope.projectId ?? ''}\u0000${scope.userId ?? ''}\u0000${key}`;
}

export function createPreferenceService(deps: Deps) {
  const { embedder } = deps;

  // set() is read-then-write across two statements inside one transaction, and
  // Neo4j has no partial unique constraint to lean on ("one live row per
  // (key, projectId, userId)" is not expressible). Two concurrent PUTs to the
  // same key therefore both saw oldP = null and both CREATEd a live version,
  // leaving the key permanently double-valued. Serialise per identity.
  //
  // In-process only, which matches the deployment model (single loopback
  // service). A multi-instance deployment would need a graph-level lock.
  const keyLocks = new Map<string, AsyncMutex>();

  async function withKeyLock<T>(key: string, scope: Scope, fn: () => Promise<T>): Promise<T> {
    const id = scopeKey(key, scope);
    let mutex = keyLocks.get(id);
    if (!mutex) {
      mutex = new AsyncMutex();
      keyLocks.set(id, mutex);
    }
    const lock = await mutex.acquire();
    try {
      return await fn();
    } finally {
      lock.release();
      // Drop the entry once nobody is waiting, so the map can't grow without
      // bound on a service that writes many distinct keys.
      if (!mutex.isLocked()) keyLocks.delete(id);
    }
  }

  async function get(key: string, scope: Scope = {}): Promise<Preference | null> {
    return read((tx) => PreferenceRepository.getActive(tx, key, scope));
  }

  async function set(input: {
    key: string;
    value: string;
    confidence?: number;
    actor?: string;
    projectId?: string;
    userId?: string;
  }): Promise<Preference> {
    const scope: Scope = {
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
    };
    const embedding = await embedder.embed(`${input.key}: ${input.value}`);
    return withKeyLock(input.key, scope, () =>
      write(async (tx) => {
        // Live preference writes use wall clock for both axes; historical
        // preference backfill can pass distinct validFrom/recordedAt later.
        const now = new Date();
        const { next, prior } = await PreferenceRepository.set(tx, {
          key: input.key,
          value: input.value,
          confidence: input.confidence ?? 0.95,
          embedding,
          validFrom: now,
          recordedAt: now,
          scope,
        });

        if (prior) {
          // Snapshot the prior value (revise) AND emit a 'supersede' event so
          // both the revision chain and the lifecycle log are intact.
          await AuditService.revise({
            tx,
            before: prior,
            kind: 'preference',
            reason: 'preference updated',
            actor: input.actor ?? PREFERENCE_ACTOR,
            eventKind: 'supersede',
            payload: { key: input.key, newId: next.id, priorId: prior.id },
          });
        } else {
          await AuditService.record({
            tx,
            kind: 'create',
            targetId: next.id,
            targetKind: 'preference',
            actor: input.actor ?? PREFERENCE_ACTOR,
            payload: { key: input.key },
          });
        }

        return next;
      }),
    );
  }

  async function listActive(scope: Scope = {}): Promise<Preference[]> {
    return read((tx) => PreferenceRepository.listActive(tx, scope));
  }

  return { get, set, listActive };
}

export type PreferenceService = ReturnType<typeof createPreferenceService>;
