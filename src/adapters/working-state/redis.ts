// Redis-backed WorkingState adapter (opt-in via WORKING_STATE_BACKEND=redis).
//
// Uses ioredis. Keys are namespaced as `ws:<scopeKey>:<key>` and store JSON-
// serialised entries. TTLs use Redis native PEXPIRE so expiry is server-side.
// list() uses SCAN to avoid blocking the event loop on large keyspaces.

import type { Redis } from 'ioredis';
import type { WorkingStateEntry, WorkingStateScope } from '../../models/types.ts';
import { type WorkingStateAdapter, scopeKey } from './types.ts';

interface SerialisedEntry {
  value: unknown;
  updatedAt: string; // ISO
  expiresAt: string | null; // ISO
}

const NAMESPACE = 'ws';

function redisKey(scope: WorkingStateScope, key: string): string {
  return `${NAMESPACE}:${scopeKey(scope)}:${key}`;
}

function scanPrefix(scope: WorkingStateScope, prefix?: string): string {
  return `${NAMESPACE}:${scopeKey(scope)}:${prefix ?? ''}*`;
}

export class RedisWorkingStateAdapter implements WorkingStateAdapter {
  constructor(private readonly client: Redis) {}

  async set(scope: WorkingStateScope, key: string, value: unknown, ttlSec?: number): Promise<void> {
    const now = new Date();
    const expiresAt = ttlSec ? new Date(now.getTime() + ttlSec * 1000) : null;
    const payload: SerialisedEntry = {
      value,
      updatedAt: now.toISOString(),
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
    const k = redisKey(scope, key);
    if (ttlSec) {
      await this.client.set(k, JSON.stringify(payload), 'PX', ttlSec * 1000);
    } else {
      await this.client.set(k, JSON.stringify(payload));
    }
  }

  async get(scope: WorkingStateScope, key: string): Promise<WorkingStateEntry | null> {
    const raw = await this.client.get(redisKey(scope, key));
    if (raw == null) return null;
    return parseEntry(raw, scope, key);
  }

  async delete(scope: WorkingStateScope, key: string): Promise<void> {
    await this.client.del(redisKey(scope, key));
  }

  async list(scope: WorkingStateScope, prefix?: string): Promise<WorkingStateEntry[]> {
    const match = scanPrefix(scope, prefix);
    const namespacePrefix = `${NAMESPACE}:${scopeKey(scope)}:`;
    const out: WorkingStateEntry[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      if (keys.length === 0) continue;
      const values = await this.client.mget(...keys);
      keys.forEach((k: string, i: number) => {
        const raw = values[i];
        if (raw == null) return;
        const userKey = k.startsWith(namespacePrefix) ? k.slice(namespacePrefix.length) : k;
        const entry = parseEntry(raw, scope, userKey);
        if (entry) out.push(entry);
      });
    } while (cursor !== '0');
    return out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async reapExpired(): Promise<number> {
    // Redis expires keys server-side via PEXPIRE; nothing to do.
    return 0;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

function parseEntry(raw: string, scope: WorkingStateScope, key: string): WorkingStateEntry | null {
  try {
    const parsed = JSON.parse(raw) as SerialisedEntry;
    return {
      scope,
      key,
      value: parsed.value,
      expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
      updatedAt: new Date(parsed.updatedAt),
    };
  } catch {
    return null;
  }
}
