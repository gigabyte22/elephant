// Schema migration. Imported by both scripts/migrate.ts (CLI) and the
// integration test setup. Runs idempotently — safe to call repeatedly.

import { loadEnv } from './config/env.ts';
import { verifyConnectivity, write } from './config/neo4j.ts';

interface Statement {
  name: string;
  cypher: string;
}

const VECTOR_INDEX_LABELS = [
  'Fact',
  'Preference',
  'Insight',
  'Episode',
  'Chunk',
  'KnowledgeDocument',
  'KnowledgeChunk',
  'Procedure',
  'Research',
  'ResearchChunk',
  'Intention',
  // Entity vectors back synonym detection (dream cycle) and query→entity
  // linking (PPR retrieval). Entity embeddings are re-derived from the entity
  // name during dreaming; see DreamingService entity-resolution step.
  'Entity',
] as const;

export function buildStatements(embedDim: number): Statement[] {
  return [
    // --- Constraints ----------------------------------------------------
    {
      name: 'constraint:entity_id',
      cypher: 'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE',
    },
    {
      name: 'constraint:fact_id',
      cypher: 'CREATE CONSTRAINT fact_id IF NOT EXISTS FOR (f:Fact) REQUIRE f.id IS UNIQUE',
    },
    {
      name: 'constraint:episode_id',
      cypher: 'CREATE CONSTRAINT episode_id IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE',
    },
    {
      name: 'constraint:preference_id',
      cypher:
        'CREATE CONSTRAINT preference_id IF NOT EXISTS FOR (p:Preference) REQUIRE p.id IS UNIQUE',
    },
    {
      name: 'index:preference_key',
      cypher: 'CREATE INDEX preference_key IF NOT EXISTS FOR (p:Preference) ON (p.key)',
    },
    {
      name: 'constraint:insight_id',
      cypher: 'CREATE CONSTRAINT insight_id IF NOT EXISTS FOR (i:Insight) REQUIRE i.id IS UNIQUE',
    },
    {
      name: 'constraint:observation_id',
      cypher:
        'CREATE CONSTRAINT observation_id IF NOT EXISTS FOR (o:Observation) REQUIRE o.id IS UNIQUE',
    },
    {
      name: 'constraint:chunk_id',
      cypher: 'CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (c:Chunk) REQUIRE c.id IS UNIQUE',
    },
    {
      name: 'constraint:system_state_key',
      cypher:
        'CREATE CONSTRAINT system_state_key IF NOT EXISTS FOR (s:SystemState) REQUIRE s.key IS UNIQUE',
    },
    // v1.2 — new memory categories + audit
    {
      name: 'constraint:knowledge_document_id',
      cypher:
        'CREATE CONSTRAINT knowledge_document_id IF NOT EXISTS FOR (d:KnowledgeDocument) REQUIRE d.id IS UNIQUE',
    },
    {
      name: 'constraint:knowledge_chunk_id',
      cypher:
        'CREATE CONSTRAINT knowledge_chunk_id IF NOT EXISTS FOR (c:KnowledgeChunk) REQUIRE c.id IS UNIQUE',
    },
    {
      name: 'constraint:procedure_id',
      cypher:
        'CREATE CONSTRAINT procedure_id IF NOT EXISTS FOR (p:Procedure) REQUIRE p.id IS UNIQUE',
    },
    {
      name: 'constraint:research_id',
      cypher: 'CREATE CONSTRAINT research_id IF NOT EXISTS FOR (r:Research) REQUIRE r.id IS UNIQUE',
    },
    {
      name: 'constraint:research_chunk_id',
      cypher:
        'CREATE CONSTRAINT research_chunk_id IF NOT EXISTS FOR (c:ResearchChunk) REQUIRE c.id IS UNIQUE',
    },
    {
      name: 'constraint:intention_id',
      cypher:
        'CREATE CONSTRAINT intention_id IF NOT EXISTS FOR (i:Intention) REQUIRE i.id IS UNIQUE',
    },
    {
      name: 'constraint:archived_revision_id',
      cypher:
        'CREATE CONSTRAINT archived_revision_id IF NOT EXISTS FOR (a:ArchivedRevision) REQUIRE a.id IS UNIQUE',
    },
    {
      name: 'constraint:audit_event_id',
      cypher:
        'CREATE CONSTRAINT audit_event_id IF NOT EXISTS FOR (e:AuditEvent) REQUIRE e.id IS UNIQUE',
    },
    {
      name: 'constraint:working_state_scope_key',
      cypher:
        'CREATE CONSTRAINT working_state_scope_key IF NOT EXISTS FOR (w:WorkingState) REQUIRE (w.scopeKey, w.key) IS UNIQUE',
    },

    // --- Generic text + temporal indexes --------------------------------
    {
      name: 'index:entity_name',
      cypher: 'CREATE TEXT INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)',
    },
    {
      // Canonical entity identity: case/whitespace-folded name. Entities are
      // merged on this so variants don't splinter. Run the backfill migration
      // (scripts/backfill-entity-norm.ts) once on pre-existing data before this
      // uniqueness constraint can be created cleanly.
      name: 'constraint:entity_name_norm',
      cypher:
        'CREATE CONSTRAINT entity_name_norm IF NOT EXISTS FOR (e:Entity) REQUIRE e.nameNorm IS UNIQUE',
    },
    {
      name: 'fulltext:fact_content',
      cypher:
        "CREATE FULLTEXT INDEX fact_fulltext IF NOT EXISTS FOR (f:Fact) ON EACH [f.content] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
    },
    {
      name: 'index:fact_temporal',
      cypher: 'CREATE INDEX fact_temporal IF NOT EXISTS FOR (f:Fact) ON (f.validFrom, f.validTo)',
    },
    {
      name: 'index:observation_expires',
      cypher: 'CREATE INDEX observation_expires IF NOT EXISTS FOR (o:Observation) ON (o.expiresAt)',
    },
    {
      name: 'index:episode_agent_id',
      cypher: 'CREATE INDEX episode_agent_id IF NOT EXISTS FOR (e:Episode) ON (e.agentId)',
    },
    {
      name: 'index:episode_session',
      cypher: 'CREATE INDEX episode_session IF NOT EXISTS FOR (e:Episode) ON (e.sessionId)',
    },
    {
      name: 'index:observation_agent_id',
      cypher: 'CREATE INDEX observation_agent_id IF NOT EXISTS FOR (o:Observation) ON (o.agentId)',
    },
    {
      name: 'fulltext:chunk_text',
      cypher:
        "CREATE FULLTEXT INDEX chunk_fulltext IF NOT EXISTS FOR (c:Chunk) ON EACH [c.text] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
    },

    // --- v1.2 cross-category scope + kind indexes -----------------------
    {
      name: 'index:memory_kind',
      cypher: 'CREATE INDEX memory_kind IF NOT EXISTS FOR (m:MemoryItem) ON (m.kind)',
    },
    {
      name: 'index:memory_project',
      cypher: 'CREATE INDEX memory_project IF NOT EXISTS FOR (m:MemoryItem) ON (m.projectId)',
    },
    {
      name: 'index:memory_user',
      cypher: 'CREATE INDEX memory_user IF NOT EXISTS FOR (m:MemoryItem) ON (m.userId)',
    },
    {
      name: 'index:memory_scope',
      cypher:
        'CREATE INDEX memory_scope IF NOT EXISTS FOR (m:MemoryItem) ON (m.projectId, m.userId, m.kind)',
    },

    // --- v1.2 fulltext for new categories -------------------------------
    {
      name: 'fulltext:knowledge_chunk_text',
      cypher:
        "CREATE FULLTEXT INDEX knowledge_chunk_fulltext IF NOT EXISTS FOR (c:KnowledgeChunk) ON EACH [c.text] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
    },
    {
      name: 'fulltext:knowledge_document_summary',
      cypher:
        "CREATE FULLTEXT INDEX knowledge_document_fulltext IF NOT EXISTS FOR (d:KnowledgeDocument) ON EACH [d.title, d.summary] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
    },
    {
      name: 'fulltext:procedure',
      cypher:
        "CREATE FULLTEXT INDEX procedure_fulltext IF NOT EXISTS FOR (p:Procedure) ON EACH [p.name, p.whenToUse, p.content] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
    },
    {
      name: 'fulltext:research',
      cypher:
        "CREATE FULLTEXT INDEX research_fulltext IF NOT EXISTS FOR (r:Research) ON EACH [r.title, r.summary] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
    },
    {
      name: 'fulltext:research_chunk_text',
      cypher:
        "CREATE FULLTEXT INDEX research_chunk_fulltext IF NOT EXISTS FOR (c:ResearchChunk) ON EACH [c.text] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
    },
    {
      name: 'fulltext:intention',
      cypher:
        "CREATE FULLTEXT INDEX intention_fulltext IF NOT EXISTS FOR (i:Intention) ON EACH [i.content] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
    },

    // --- Intention (prospective memory) due-poll index ------------------
    // Composite (status, dueAt) so listDue is a range scan, not a label scan.
    {
      name: 'index:intention_due',
      cypher: 'CREATE INDEX intention_due IF NOT EXISTS FOR (i:Intention) ON (i.status, i.dueAt)',
    },

    // --- v1.2 procedure name lookup -------------------------------------
    {
      name: 'index:procedure_name_project',
      cypher:
        'CREATE INDEX procedure_name_project IF NOT EXISTS FOR (p:Procedure) ON (p.name, p.projectId)',
    },

    // --- v1.2 audit + revision indexes ----------------------------------
    {
      name: 'index:archived_revision_original',
      cypher:
        'CREATE INDEX archived_revision_original IF NOT EXISTS FOR (a:ArchivedRevision) ON (a.originalId)',
    },
    {
      name: 'index:audit_event_target',
      cypher:
        'CREATE INDEX audit_event_target IF NOT EXISTS FOR (e:AuditEvent) ON (e.targetId, e.at)',
    },
    {
      name: 'index:audit_event_at',
      cypher: 'CREATE INDEX audit_event_at IF NOT EXISTS FOR (e:AuditEvent) ON (e.at)',
    },

    // --- v1.2 working state -------------------------------------------
    {
      name: 'index:working_state_expires',
      cypher:
        'CREATE INDEX working_state_expires IF NOT EXISTS FOR (w:WorkingState) ON (w.expiresAt)',
    },

    // --- Per-label vector indexes (Neo4j 5.18+ / 2026.x) ----------------
    ...VECTOR_INDEX_LABELS.map((label) => ({
      name: `vector:${label.toLowerCase()}_vectors`,
      cypher: `CREATE VECTOR INDEX ${label.toLowerCase()}_vectors IF NOT EXISTS
FOR (n:${label})
ON n.embedding
OPTIONS {
  indexConfig: {
    \`vector.dimensions\`: ${embedDim},
    \`vector.similarity_function\`: 'cosine'
  }
}`,
    })),
  ];
}

export async function migrate(opts: { log?: (msg: string) => void } = {}): Promise<void> {
  const log = opts.log ?? (() => undefined);
  const env = loadEnv();
  log(`[migrate] connecting to ${env.NEO4J_URI} (db=${env.NEO4J_DATABASE})`);
  await verifyConnectivity();
  log(`[migrate] connected. embedding dim = ${env.EMBED_DIM}`);

  const statements = buildStatements(env.EMBED_DIM);
  for (const stmt of statements) {
    await write(async (tx) => {
      await tx.run(stmt.cypher);
    });
    log(`[migrate] applied ${stmt.name}`);
  }

  await write(async (tx) => {
    await tx.run('CALL db.awaitIndexes(60000)');
  });
  log('[migrate] all indexes online');
}
