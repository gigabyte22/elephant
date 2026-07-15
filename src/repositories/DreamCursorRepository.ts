import type { ManagedTransaction } from 'neo4j-driver';
import { toJsDate } from '../utils/neo4j-conv.ts';

// Persistent cursor for the dream cycle. Stored on a :SystemState node so a
// time-boxed or mid-crash run can resume from the last processed episode
// timestamp instead of restarting from "last completed dream run" and
// re-processing everything.
//
// We track timestamp (not just episode id) because Episodes are ordered by
// timestamp in listSince; the cursor advances monotonically with each
// processed episode.

const CURSOR_KEY = 'dream.cursor';

export const DreamCursorRepository = {
  async get(tx: ManagedTransaction): Promise<Date | null> {
    const result = await tx.run('MATCH (s:SystemState {key: $key}) RETURN s.cursor AS cursor', {
      key: CURSOR_KEY,
    });
    const raw = result.records[0]?.get('cursor');
    return raw == null ? null : toJsDate(raw);
  },

  async set(tx: ManagedTransaction, at: Date): Promise<void> {
    await tx.run(
      `MERGE (s:SystemState {key: $key})
       SET s.cursor = datetime($at), s.updatedAt = datetime()`,
      { key: CURSOR_KEY, at: at.toISOString() },
    );
  },
};
