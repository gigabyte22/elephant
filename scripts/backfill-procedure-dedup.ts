// One-shot cleanup for procedures duplicated by the pre-fix
// `ProcedureService.update` (which wrote the new body onto the original node
// AND created a superseding clone, retiring neither — so every body edit left
// two identical live nodes behind).
//
// The corrected model keeps exactly one live node per `:SUPERSEDES`-connected
// lineage (the newest) and retires the rest via `expiresAt = now`. This script
// brings historical data in line: it groups every procedure touched by a
// SUPERSEDES edge into lineages, keeps the highest-version node (tie-broken by
// newest id — UUIDv7 sorts by creation), and stamps `expiresAt` on the others.
//
// Run it ONCE, AFTER deploying the code fix (so no new duplicates are created
// mid-backfill):  tsx scripts/backfill-procedure-dedup.ts
//
// It is idempotent — a second run finds each lineage already single-live and
// only ever touches still-live non-survivors (none remain), so it no-ops.

import { closeDriver, read, verifyConnectivity, write } from '../src/config/neo4j.ts';

interface ProcNode {
  id: string;
  version: number;
  retired: boolean;
}

// Minimal union-find over string ids.
class DisjointSet {
  private parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression.
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    this.parent.set(this.find(a), this.find(b));
  }
}

async function run(): Promise<void> {
  await verifyConnectivity();

  // Every procedure that participates in a SUPERSEDES edge, with its version
  // and whether it is already retired.
  const nodes = await read(async (tx) => {
    const result = await tx.run(
      `MATCH (p:Procedure)
       WHERE (p)-[:SUPERSEDES]-(:Procedure)
       RETURN p.id AS id, coalesce(p.version, 1) AS version, p.expiresAt IS NOT NULL AS retired`,
    );
    return result.records.map((r) => ({
      id: r.get('id') as string,
      version: Number(r.get('version')),
      retired: r.get('retired') as boolean,
    })) as ProcNode[];
  });

  if (nodes.length === 0) {
    console.log('[backfill] no superseded procedures — nothing to dedup');
    return;
  }

  const edges = await read(async (tx) => {
    const result = await tx.run(
      `MATCH (newP:Procedure)-[:SUPERSEDES]->(oldP:Procedure)
       RETURN oldP.id AS oldId, newP.id AS newId`,
    );
    return result.records.map((r) => ({
      oldId: r.get('oldId') as string,
      newId: r.get('newId') as string,
    }));
  });

  // Build lineages (connected components over SUPERSEDES).
  const dsu = new DisjointSet();
  const byId = new Map<string, ProcNode>();
  for (const n of nodes) {
    dsu.add(n.id);
    byId.set(n.id, n);
  }
  for (const e of edges) dsu.union(e.oldId, e.newId);

  const lineages = new Map<string, ProcNode[]>();
  for (const n of nodes) {
    const root = dsu.find(n.id);
    const group = lineages.get(root) ?? [];
    group.push(n);
    lineages.set(root, group);
  }

  // Survivor per lineage: highest version, tie-broken by newest id.
  const toRetire: string[] = [];
  let lineagesTouched = 0;
  for (const group of lineages.values()) {
    const [survivor, ...rest] = [...group].sort((a, b) =>
      b.version !== a.version ? b.version - a.version : b.id.localeCompare(a.id),
    );
    const stale = rest.filter((n) => !n.retired);
    if (stale.length > 0) {
      lineagesTouched += 1;
      for (const n of stale) toRetire.push(n.id);
      console.log(
        `[backfill] lineage of ${group.length}: keep ${survivor!.id} (v${survivor!.version}), retire ${stale.length}`,
      );
    }
  }

  if (toRetire.length === 0) {
    console.log(`[backfill] ${lineages.size} lineage(s) already single-live — nothing to retire`);
    return;
  }

  await write(async (tx) => {
    await tx.run(
      `MATCH (p:Procedure)
       WHERE p.id IN $ids AND p.expiresAt IS NULL
       SET p.expiresAt = datetime()`,
      { ids: toRetire },
    );
  });

  console.log(
    `[backfill] done — retired ${toRetire.length} duplicate procedure(s) across ${lineagesTouched} lineage(s)`,
  );
}

run()
  .then(() => closeDriver())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[backfill] failed:', err);
    await closeDriver().catch(() => undefined);
    process.exit(1);
  });
