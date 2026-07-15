// Maintains the named GDS in-memory graph that Personalized PageRank retrieval
// runs against. Refreshed at the end of each dream cycle (when PPR is enabled)
// so the projection and the dream-built RELATES/SYNONYM edges advance together.
// Querying a stale projection is acceptable for an experimental store; a missing
// projection just makes the PPR stage a no-op (it degrades, never errors).

import { read, write } from '../../config/neo4j.ts';

export const PPR_GRAPH_NAME = 'memgraph';

// Node labels + the relationship types PageRank traverses. Only types that
// actually exist in the DB are projected — GDS native projection rejects
// unknown relationship types, and a fresh graph has no RELATES/SYNONYM yet.
const NODE_LABELS = ['Entity', 'Fact'] as const;
const REL_TYPES = ['HAS_FACT', 'RELATES', 'SYNONYM'] as const;

function numFrom(v: unknown): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : (v as { toNumber(): number }).toNumber();
}

export interface ProjectionInfo {
  nodeCount: number;
  relationshipCount: number;
  // True when there were no projectable edges yet, so nothing was created.
  skipped: boolean;
}

export function createGraphProjectionService() {
  let lastReprojectedAt: Date | null = null;

  async function exists(): Promise<boolean> {
    return read(async (tx) => {
      const r = await tx.run('CALL gds.graph.exists($name) YIELD exists RETURN exists', {
        name: PPR_GRAPH_NAME,
      });
      return Boolean(r.records[0]?.get('exists'));
    });
  }

  async function drop(): Promise<void> {
    // failIfMissing=false → idempotent.
    await write(async (tx) => {
      await tx.run('CALL gds.graph.drop($name, false) YIELD graphName RETURN graphName', {
        name: PPR_GRAPH_NAME,
      });
    });
  }

  // Relationship types present in the DB, intersected with the set PPR uses.
  async function projectableRelTypes(): Promise<string[]> {
    const present = await read(async (tx) => {
      const r = await tx.run(
        'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType',
      );
      return new Set(r.records.map((rec) => rec.get('relationshipType') as string));
    });
    return REL_TYPES.filter((t) => present.has(t));
  }

  async function refresh(): Promise<ProjectionInfo> {
    await drop();
    const types = await projectableRelTypes();
    if (types.length === 0) {
      // No edges to walk yet — leave the projection absent so PPR no-ops.
      return { nodeCount: 0, relationshipCount: 0, skipped: true };
    }
    // Undirected so PageRank mass flows both ways across RELATES/SYNONYM and
    // up from facts to their entities.
    const relMap = Object.fromEntries(types.map((t) => [t, { orientation: 'UNDIRECTED' }]));
    const info = await write(async (tx) => {
      const r = await tx.run(
        `CALL gds.graph.project($name, $nodes, $relMap)
         YIELD nodeCount, relationshipCount
         RETURN nodeCount, relationshipCount`,
        { name: PPR_GRAPH_NAME, nodes: [...NODE_LABELS], relMap },
      );
      const rec = r.records[0];
      return {
        nodeCount: numFrom(rec?.get('nodeCount')),
        relationshipCount: numFrom(rec?.get('relationshipCount')),
        skipped: false,
      };
    });
    lastReprojectedAt = new Date();
    return info;
  }

  return {
    refresh,
    exists,
    drop,
    lastReprojectedAt(): Date | null {
      return lastReprojectedAt;
    },
  };
}

export type GraphProjectionService = ReturnType<typeof createGraphProjectionService>;
