// Pluggable backend for live key/value working state.
//
// Why pluggable? The default Neo4j implementation keeps everything in one
// graph (matches the project's "single inspectable" goal). For high-frequency
// orchestration workloads (>>100 writes/sec per agent, sub-100ms latency),
// callers can swap to Redis without touching service code.
//
// WorkingState is **not** a memory item: no :MemoryItem label, no embedding,
// no retrieval pipeline involvement. It's an opaque scope-keyed JSON store
// for live agent/session state.

import type { WorkingStateEntry, WorkingStateScope } from '../../models/types.ts';

export interface WorkingStateAdapter {
  set(scope: WorkingStateScope, key: string, value: unknown, ttlSec?: number): Promise<void>;
  get(scope: WorkingStateScope, key: string): Promise<WorkingStateEntry | null>;
  delete(scope: WorkingStateScope, key: string): Promise<void>;
  list(scope: WorkingStateScope, prefix?: string): Promise<WorkingStateEntry[]>;
  /** Best-effort cleanup of expired entries (Neo4j backend; Redis is a no-op). */
  reapExpired?(now: Date): Promise<number>;
  /** Optional teardown (close clients, etc.). */
  close?(): Promise<void>;
}

/**
 * Stable string key for a scope tuple. Used by both backends:
 *   - Neo4j: composite uniqueness with `key` for fast lookups.
 *   - Redis: namespace prefix.
 */
export function scopeKey(scope: WorkingStateScope): string {
  return [
    `agent:${scope.agentId}`,
    scope.sessionId ? `session:${scope.sessionId}` : '',
    scope.userId ? `user:${scope.userId}` : '',
    scope.projectId ? `project:${scope.projectId}` : '',
  ]
    .filter(Boolean)
    .join('|');
}
