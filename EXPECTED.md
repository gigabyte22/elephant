1. Service HTTP surface
Base: http://127.0.0.1:18790 (or whatever port — loopback-only by convention).

All responses { ok: true, data } | { ok: false, error }. All writes idempotent via client-supplied id.


POST   /episodes                    ingest raw conversation turn → returns episodeId
POST   /facts                       save one fact (explicit, from user or agent)
POST   /facts/batch                 save many (for dreaming pipeline)
POST   /facts/:id/supersede         explicit supersede (reason, newFactId)
DELETE /facts/:id                   soft-delete (sets validTo=now)

GET    /recall                      hybrid retrieve — query params below
GET    /timeline                    bi-temporal: what was valid at time T?
GET    /entities/:id                entity + its facts subgraph
GET    /entities?name=…             fuzzy entity lookup

GET    /preferences/:key            single pref
PUT    /preferences/:key            set/update pref (auto-supersede old)
GET    /preferences                 all active prefs

POST   /observations                working memory write (TTL 7d)
GET    /observations?sessionId=…    session-scoped recall

POST   /dream                       trigger dream cycle (async, returns jobId)
GET    /dream/:jobId                poll status
GET    /health                      { ok, neo4j, embedModel, lastDream }

# v1.2 — knowledge / procedural / research / working-state / audit
POST   /knowledge/documents         ingest a shared/RAG document (chunked + embedded)
GET    /knowledge/documents/:id     fetch one document
GET    /knowledge/documents         list (scope-filtered: projectId, userId, limit)
DELETE /knowledge/documents/:id     soft-delete (use ?purge=true to also drop chunks)

POST   /procedures                  create a skill / workflow / how-to
GET    /procedures/:id              fetch one procedure
PUT    /procedures/:id              update (auto :ArchivedRevision + :SUPERSEDES on body change)
GET    /procedures?name=…&projectId=…   lookup or paginated list
DELETE /procedures/:id              soft-delete

POST   /research                    project-scoped research artifact (projectId required)
GET    /research/:id                fetch one
GET    /research?projectId=…        list (projectId required)
DELETE /research/:id                soft-delete

POST   /state                       set working-state value (scope, key, value, ttlSec?)
GET    /state/:key?agentId=…        read a key
DELETE /state/:key?agentId=…        delete
GET    /state?agentId=…&prefix=…    list keys for a scope

GET    /audit/:targetId             revision history + audit events for an item
GET    /audit?actor=…&from=…&to=…   query the global audit event log
/recall query (the hot path)

GET /recall?
  q=<text>              # embedded server-side
  &agentId=<id>         # optional, scope axis (boost by default)
  &sessionId=<id>       # optional, biases toward session context
  &agentScope=boost|filter|none
  &sessionScope=boost|filter|none
  # v1.2: cross-cutting scope axes (same boost/filter/none semantics)
  &projectId=<id>
  &userId=<id>
  &projectScope=boost|filter|none
  &userScope=boost|filter|none
  # v1.2: restrict to a subset of memory categories (comma-separated).
  # Valid kinds: episode,chunk,fact,preference,insight,observation,
  # knowledge_document,knowledge_chunk,procedure,research.
  &kinds=fact,knowledge_chunk,procedure
  &from=<iso>&to=<iso>  # temporal window
  &minImportance=0.3
  &minConfidence=0.5
  &limit=20
  &includeSuperseded=false
  &entityId=<id>        # constrain to subgraph
  # Per-category opt-ins. Defaults: chunks=on-request, prefs/insights=on,
  # knowledge/procedures/research=off (must opt in to pay vector cost).
  &includeChunks=true
  &includePreferences=true
  &includeInsights=true
  &includeKnowledge=true
  &includeProcedures=true
  &includeResearch=true
Returns ranked Fact[] + optional relatedEntities[] for GraphRAG expansion,
plus v1.2 categories (knowledgeChunks[], procedures[], research[]) when
explicitly opted into via includeKnowledge / includeProcedures / includeResearch.

2. Orchestrator-side tools
Keep the existing memory_save / memory_recall / memory_forget names so existing soul prompts still work — just reimplement them against the service. Add new ones for the richer surface.


// src/tools/builtins/memory-recall.ts (rewrite)
{
  name: 'memory_recall',
  description: 'Recall facts from long-term memory. Supports temporal and importance filters.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language query' },
      from: { type: 'string', description: 'ISO date — only facts valid after this' },
      to: { type: 'string', description: 'ISO date — only facts valid before this' },
      minImportance: { type: 'number', description: '0-1, default 0' },
      limit: { type: 'number', description: 'default 10' },
    },
    required: ['query'],
  },
  isReadOnly: true,
  alwaysLoad: true,
}

// memory_save — unchanged signature, but now POSTs to /facts
{
  name: 'memory_save',
  parameters: {
    properties: {
      fact: { type: 'string' },
      category: { type: 'string' },
      importance: { type: 'number', description: '0-1, default 0.5' },
      entities: { type: 'array', items: { type: 'string' },
                  description: 'Named entities this fact is about' },
    },
    required: ['fact'],
  },
}

// memory_forget — now soft-delete via /facts/:id or query-based
{
  name: 'memory_forget',
  parameters: {
    properties: {
      query: { type: 'string', description: 'Match facts to soft-delete' },
      factId: { type: 'string', description: 'Exact fact id (preferred)' },
    },
  },
}
New tools:


memory_timeline          // bi-temporal: "what did I believe about X on 2026-03-01?"
  params: { entity?: string, query?: string, at: string /* ISO */ }

memory_entity            // fetch entity + its fact subgraph
  params: { name?: string, id?: string, depth?: number /* default 1 */ }

memory_preference_get    // read a preference
  params: { key: string }

memory_preference_set    // write (auto-supersedes old value)
  params: { key: string, value: string, confidence?: number }

memory_observe           // working memory (session-scoped, TTL)
  params: { note: string, sessionId?: string /* from ctx */ }
Skip exposing /dream as a tool — run it via croner on a schedule; expose only a CLI/admin command for manual trigger.

3. Shared types (put in src/shared/memory-types.ts)

// v1.2: every memory item carries optional projectId / userId scope props.
// The hybrid label model means every item also has a kind discriminator
// alongside its category-specific Neo4j label (Fact, Preference, Procedure,
// KnowledgeDocument, KnowledgeChunk, Research, …).

export type MemoryKind =
  | 'episode' | 'chunk' | 'fact' | 'preference' | 'insight' | 'observation'
  | 'knowledge_document' | 'knowledge_chunk' | 'procedure' | 'research';

export interface Scope { projectId?: string; userId?: string }

export interface Fact extends Scope {
  id: string;
  content: string;
  category?: string;
  confidence: number;        // 0-1
  importance: number;        // 0-1
  validFrom: string;         // ISO
  validTo: string | null;    // null = still valid
  recordedAt: string;
  entities: string[];        // entity ids
  supersedes?: string;       // prior factId
  sourceEpisodeId?: string;
}

export interface RecallResult {
  facts: Array<Fact & { score: number }>;
  entities?: Array<{ id: string; name: string; type: string }>;
  // v1.2 — surfaced when caller opts in via include* flags.
  knowledgeChunks?: Array<KnowledgeChunk & { score: number }>;
  procedures?: Array<Procedure & { score: number }>;
  research?: Array<Research & { score: number }>;
}

export interface Preference extends Scope {
  key: string;
  value: string;
  confidence: number;
  validFrom: string;
  validTo: string | null;
}

export interface KnowledgeDocument extends Scope {
  id: string; title: string; source: string; sourceUri?: string;
  contentHash?: string; summary: string; tags: string[];
  expiresAt: string | null; createdAt: string; updatedAt: string;
}

export interface KnowledgeChunk extends Scope {
  id: string; documentId: string; position: number; text: string;
  createdAt: string;
}

export interface Procedure extends Scope {
  id: string; name: string; version: number;
  content: string; whenToUse: string;
  successRate: number; invocationCount: number;
  lastSuccessAt: string | null; expiresAt: string | null;
  createdAt: string; updatedAt: string;
}

export interface Research extends KnowledgeDocument { projectId: string }

export interface WorkingStateScope {
  agentId: string; sessionId?: string; userId?: string; projectId?: string;
}
export interface WorkingStateEntry {
  scope: WorkingStateScope; key: string; value: unknown;
  expiresAt: string | null; updatedAt: string;
}

export interface ArchivedRevision {
  id: string; originalId: string; originalKind: MemoryKind;
  snapshot: unknown; archivedAt: string; reason: string; archivedBy?: string;
}
export interface AuditEvent {
  id: string;
  kind: 'create'|'update'|'supersede'|'soft_delete'|'prune'|'promote'|'archive';
  targetId: string; targetKind: MemoryKind;
  payload: unknown; at: string; actor?: string;
}
4. Client wrapper pattern
One place, reused by every tool:


// src/memory/remote-client.ts
export class MemoryClient {
  constructor(private baseUrl: string, private fallback?: MemoryStore) {}

  async recall(opts: RecallQuery): Promise<RecallResult> {
    try {
      return await this.fetch('/recall', opts);
    } catch (err) {
      logger.warn('Memory service unavailable, falling back to MEMORY.md', { err });
      if (!this.fallback) throw err;
      const facts = this.fallback.recall(opts.query);
      return { facts: facts.map(toLegacyFact) };
    }
  }
  // …save, forget, timeline, etc.
}
Keep your orchestrator's existing local memory store as the degradation path — it stays functional if Neo4j is down.

5. Config additions (.env)

MEMORY_SERVICE_URL=http://127.0.0.1:18790
MEMORY_SERVICE_TOKEN=<shared secret — even on loopback>
MEMORY_FALLBACK_TO_FILE=true
Contract-first tip: write the RecallResult / Fact types in a tiny shared package (or just duplicate them in both repos and pin with a version string in /health). The service's job is to make /recall return something the tool can hand straight to the LLM — don't leak Neo4j node structure through the wire.