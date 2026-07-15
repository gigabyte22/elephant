// Thin wrapper over the WorkingStateAdapter. Lives in services/ so HTTP
// routes import a service rather than the adapter directly, mirroring the
// rest of the codebase.

import type { WorkingStateAdapter } from '../adapters/working-state/types.ts';
import type { WorkingStateEntry, WorkingStateScope } from '../models/types.ts';

interface Deps {
  adapter: WorkingStateAdapter;
}

export function createWorkingStateService(deps: Deps) {
  const { adapter } = deps;

  return {
    async set(
      scope: WorkingStateScope,
      key: string,
      value: unknown,
      ttlSec?: number,
    ): Promise<void> {
      await adapter.set(scope, key, value, ttlSec);
    },
    async get(scope: WorkingStateScope, key: string): Promise<WorkingStateEntry | null> {
      return adapter.get(scope, key);
    },
    async delete(scope: WorkingStateScope, key: string): Promise<void> {
      await adapter.delete(scope, key);
    },
    async list(scope: WorkingStateScope, prefix?: string): Promise<WorkingStateEntry[]> {
      return adapter.list(scope, prefix);
    },
    async reapExpired(now: Date = new Date()): Promise<number> {
      return adapter.reapExpired ? adapter.reapExpired(now) : 0;
    },
  };
}

export type WorkingStateService = ReturnType<typeof createWorkingStateService>;
