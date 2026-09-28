// Ordered data migrations. `migrate()` (src/migrate.ts) applies the schema
// statements first, then every entry here whose id has no (:SchemaMigration)
// node yet, recording one as each succeeds. Append new entries at the end and
// never renumber or edit an applied one: its id is what marks it done.
//
// A migration can meet any graph — a fresh one, or one where an older release
// already applied the same fix by hand from a scripts/backfill-*.ts — so every
// entry must be idempotent and a no-op on data it has already fixed.
//
// Operator tools that need a judgment call stay scripts rather than entries
// here: backfill-fact-bitemporal (would overwrite a caller-supplied validFrom),
// backfill-fact-supersede-checked (needs this deployment's cutover instant),
// backfill-retire-legacy-user-ids (needs the values to retire) and
// backfill-attachment-extraction (calls the vision/transcription providers).

import { read, write } from './config/neo4j.ts';

export interface Migration {
  id: string;
  description: string;
  run(log: (msg: string) => void): Promise<void>;
}

const BATCH = 500;

// Runs a batched write until it reports no rows touched. Each batch must take
// its own rows out of the match, which is what ends the loop.
async function drain(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await write(async (tx) => {
      const r = await tx.run(cypher, params);
      return Number(r.records[0]?.get('n') ?? 0);
    });
    if (n === 0) return total;
    total += n;
  }
}

// v1.2 introduced the `:MemoryItem` base label and `kind` property on every
// memory node. Graphs older than that carry only the category label.
const memoryItemLabels: Migration = {
  id: '0001-memory-item-labels',
  description: 'add :MemoryItem and kind to pre-v1.2 memory nodes',
  async run(log) {
    const steps = [
      ['Episode', 'episode'],
      ['Chunk', 'chunk'],
      ['Fact', 'fact'],
      ['Preference', 'preference'],
      ['Insight', 'insight'],
      ['Observation', 'observation'],
    ] as const;
    for (const [label, kind] of steps) {
      const n = await drain(
        `MATCH (n:${label})
         WHERE NOT n:MemoryItem OR n.kind IS NULL
         WITH n LIMIT ${BATCH}
         SET n:MemoryItem, n.kind = $kind
         RETURN count(n) AS n`,
        { kind },
      );
      if (n > 0) log(`  ${label}: ${n} node(s) labelled`);
    }
  },
};

// Entities used to merge on the exact `name`, so "Alice" and "alice " were
// separate nodes. Identity is now the case/whitespace-folded `nameNorm`: stamp
// it where missing, collapse each duplicate group onto its best-connected
// member, and only then create the uniqueness constraint, which could not be
// created while duplicates existed.
const entityNameNorm: Migration = {
  id: '0002-entity-name-norm',
  description: 'stamp Entity.nameNorm, merge duplicates, add the uniqueness constraint',
  async run(log) {
    await write((tx) =>
      tx.run('MATCH (e:Entity) WHERE e.nameNorm IS NULL SET e.nameNorm = toLower(trim(e.name))'),
    );
    const groups = await read(async (tx) => {
      const r = await tx.run(
        `MATCH (e:Entity)
         OPTIONAL MATCH (e)-[h:HAS_FACT]->()
         WITH e, count(h) AS deg
         ORDER BY deg DESC, e.id
         WITH e.nameNorm AS norm, collect(e.id) AS ids
         WHERE size(ids) > 1
         RETURN ids`,
      );
      return r.records.map((rec) => rec.get('ids') as string[]);
    });
    for (const [survivorId, ...loserIds] of groups) {
      await write((tx) =>
        tx.run(
          `MATCH (survivor:Entity {id: $survivorId})
           UNWIND $loserIds AS lid
           MATCH (loser:Entity {id: lid})
           OPTIONAL MATCH (loser)-[:HAS_FACT]->(f)
           WITH survivor, loser, collect(f) AS facts
           FOREACH (f IN facts | MERGE (survivor)-[:HAS_FACT]->(f))
           DETACH DELETE loser`,
          { survivorId, loserIds },
        ),
      );
    }
    if (groups.length > 0) log(`  merged ${groups.length} duplicate entity group(s)`);
    await write((tx) =>
      tx.run(
        'CREATE CONSTRAINT entity_name_norm IF NOT EXISTS FOR (e:Entity) REQUIRE e.nameNorm IS UNIQUE',
      ),
    );
  },
};

// The dream cycle used to track progress with one :SystemState {key:
// 'dream.cursor'} timestamp; it now marks each episode (dreamedAt). Stamp
// recordedAt where it predates the field (it only orders the work queue), then
// mark as dreamed the episodes at or below the old cursor that produced facts.
// Ones below it with no facts are most likely backdated episodes the old
// selector could never see, so they are left for the next cycle to pick up.
const episodeDreamMarkers: Migration = {
  id: '0003-episode-dream-markers',
  description: 'move the dream cursor onto per-episode dreamedAt markers',
  async run(log) {
    const stamped = await drain(
      `MATCH (e:Episode) WHERE e.recordedAt IS NULL
       WITH e LIMIT ${BATCH}
       SET e.recordedAt = e.timestamp
       RETURN count(e) AS n`,
    );
    const cursor = await read(async (tx) => {
      const r = await tx.run("MATCH (s:SystemState {key: 'dream.cursor'}) RETURN s.cursor AS c");
      return r.records[0]?.get('c') ?? null;
    });
    const marked =
      cursor === null
        ? 0
        : await drain(
            `MATCH (e:Episode)
             WHERE e.dreamedAt IS NULL AND e.timestamp <= $cursor
               AND EXISTS { MATCH (e)-[:CONTAINS]->(:Fact) }
             WITH e LIMIT ${BATCH}
             SET e.dreamedAt = $cursor
             RETURN count(e) AS n`,
            { cursor },
          );
    if (stamped + marked > 0) log(`  recordedAt stamped: ${stamped}, marked dreamed: ${marked}`);
  },
};

// A since-fixed ProcedureService.update left two live nodes per body edit. Keep
// one live node per SUPERSEDES lineage (highest version, then newest id —
// UUIDv7 sorts by creation) and retire the rest with expiresAt.
const procedureLineageDedup: Migration = {
  id: '0004-procedure-lineage-dedup',
  description: 'retire duplicate live procedures left by the pre-fix update path',
  async run(log) {
    const { nodes, edges } = await read(async (tx) => {
      const n = await tx.run(
        `MATCH (p:Procedure) WHERE (p)-[:SUPERSEDES]-(:Procedure)
         RETURN p.id AS id, coalesce(p.version, 1) AS version, p.expiresAt IS NULL AS live`,
      );
      const e = await tx.run(
        'MATCH (newP:Procedure)-[:SUPERSEDES]->(oldP:Procedure) RETURN oldP.id AS a, newP.id AS b',
      );
      return {
        nodes: n.records.map((r) => ({
          id: r.get('id') as string,
          version: Number(r.get('version')),
          live: r.get('live') as boolean,
        })),
        edges: e.records.map((r) => [r.get('a') as string, r.get('b') as string] as const),
      };
    });
    if (nodes.length === 0) return;

    // Lineages are the connected components over SUPERSEDES (union-find).
    const parent = new Map(nodes.map((n) => [n.id, n.id]));
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root) ?? root;
      parent.set(id, root);
      return root;
    };
    for (const [a, b] of edges) parent.set(find(a), find(b));

    const lineages = new Map<string, typeof nodes>();
    for (const n of nodes) {
      const root = find(n.id);
      lineages.set(root, [...(lineages.get(root) ?? []), n]);
    }
    const toRetire: string[] = [];
    for (const group of lineages.values()) {
      const [, ...rest] = [...group].sort((a, b) =>
        b.version !== a.version ? b.version - a.version : b.id.localeCompare(a.id),
      );
      for (const n of rest) if (n.live) toRetire.push(n.id);
    }
    if (toRetire.length === 0) return;
    await write((tx) =>
      tx.run(
        `MATCH (p:Procedure) WHERE p.id IN $ids AND p.expiresAt IS NULL
         SET p.expiresAt = datetime()`,
        { ids: toRetire },
      ),
    );
    log(`  retired ${toRetire.length} duplicate procedure(s)`);
  },
};

// Before the lifecycle split, deleting a fact and pruning it both only closed
// validTo. Classify those tombstones from the audit log, which recorded which
// one happened. Rows with no audit event default to prunedAt: it does not gate
// reads, so a wrong guess leaves the row exactly as visible as it was, where
// deletedAt would retroactively hide history. Superseded facts and
// consolidation merge members are closed for other reasons and are skipped.
const factLifecycle: Migration = {
  id: '0005-fact-lifecycle',
  description: 'classify pre-split fact tombstones as deletedAt or prunedAt',
  async run(log) {
    const n = await drain(
      `MATCH (f:Fact)
       WHERE f.validTo IS NOT NULL AND f.deletedAt IS NULL AND f.prunedAt IS NULL
         AND NOT EXISTS { MATCH (:Fact)-[:SUPERSEDES]->(f) }
         AND NOT EXISTS {
           MATCH (s:Fact) WHERE s.mergedFromFactIds IS NOT NULL AND f.id IN s.mergedFromFactIds
         }
       WITH f LIMIT ${BATCH}
       WITH f, EXISTS {
         MATCH (a:AuditEvent) WHERE a.targetId = f.id AND a.kind = 'soft_delete'
       } AS deleted
       SET f.deletedAt = CASE WHEN deleted THEN f.validTo ELSE NULL END,
           f.prunedAt = CASE WHEN deleted THEN NULL ELSE f.validTo END
       RETURN count(f) AS n`,
    );
    if (n > 0) log(`  classified ${n} fact tombstone(s)`);
  },
};

export const MIGRATIONS: readonly Migration[] = [
  memoryItemLabels,
  entityNameNorm,
  episodeDreamMarkers,
  procedureLineageDedup,
  factLifecycle,
];
