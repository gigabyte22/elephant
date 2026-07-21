Memory Layer Build Specification (TypeScript + Neo4j – Production-Ready 2026)
This is a complete, buildable spec for the exact memory architecture I described earlier. It uses Neo4j 2026.x (native VECTOR type, SEARCH clause with in-index filters, full-text indexes, temporal primitives) as the single source of truth for all layers. No separate vector DB or SQL layer is needed.
Everything is typed, testable, and ready for an agentic orchestrator (LangGraph.js, custom loop, or Microsoft Agent Framework + neo4j-agent-memory extension).

## v1.2 — Hybrid label model + extended categories

Every memory node now carries the base label `:MemoryItem` alongside its
category-specific label, plus a `kind` string property mirroring that label
for label-agnostic filtering. Multi-label nodes are zero-cost in Neo4j and
this gives us both fast global search across the whole graph **and** fast
per-category queries against the existing labels.

```cypher
-- Global search across every memory category, with metadata filters.
MATCH (m:MemoryItem)
WHERE m.projectId = $projectId
  AND m.kind IN $kinds
  AND m.embedding IS NOT NULL
CALL db.index.vector.queryNodes('fact_vectors', 10, $vec) YIELD node, score
RETURN node.kind, labels(node), node, score ORDER BY score DESC

-- Per-category queries are still fast — the secondary label is a label scan.
MATCH (p:Procedure) WHERE p.projectId = $projectId RETURN p
```

Categories supported in v1.2 (existing + new):

- **Episodic** — `:Episode`, `:Chunk`, `:Observation` (existing).
- **Facts / Preferences** — `:Fact`, `:Preference` (existing, bi-temporal + supersede).
- **Insights** — `:Insight` (existing, promoted from high-importance facts during dreaming).
- **Knowledge** — `:KnowledgeDocument` + `:KnowledgeChunk` (new). Shared / RAG documents.
- **Procedural** — `:Procedure` (new). Skills, workflows, agent how-to. Versioned via `:SUPERSEDES` chains.
- **Research** — `:Research` + `:ResearchChunk` (new). Project-scoped research artifacts; same shape as KnowledgeDocument but `projectId` is required. The full `content` body is retained on the node (like KnowledgeDocument) — `contentHash` + `summary` are derived from it, never a replacement for it. Bodies chunk into `:ResearchChunk` with their own vector + fulltext indexes (see the OKF vault section), kept separate from `:KnowledgeChunk` because a shared vector index cannot pre-filter by kind and would shrink effective top-K for both.
- **Prospective** — `:Intention`. A durable record of a forward-looking commitment ("notify before the registration expires"). Requires either `dueAt` or a free-text `triggerHint`. Bi-temporal like `:Fact`: `validTo` is set on reaching a terminal status (`completed` / `cancelled` / `expired`). **Elephant never fires intentions** — it is pull-only, and an external orchestrator owns the clock; `GET /intentions/due` exists for boot-time reconciliation, not continuous polling.

Cross-cutting scope axes on every memory item: `projectId`, `userId`, plus the existing `agentId` / `sessionId`. Each axis runs in retrieval mode `boost` (default when a value is supplied), `filter` (hard match, but a null scope is a shared global and still matches), `strict` (like `filter`, and also excludes nulls), or `none`.

Audit / revision history: every mutating write to a Fact / Preference /
Procedure / KnowledgeDocument / Research routes through a shared `revise()`
helper that snapshots the prior state into an `:ArchivedRevision` node and
emits an `:AuditEvent`. `:SUPERSEDES` edges + `validTo` stay as the
authoritative bi-temporal lineage; revisions cover edits that don't supersede
(content tweaks, importance bumps, expiry changes).

Working state: pluggable `WorkingStateAdapter` (Neo4j default + Redis option,
selected by `WORKING_STATE_BACKEND`). Sits beside `:Observation` (which stays
as the per-session log of "things observed"); the WorkingState adapter is for
opaque key/value live orchestration state (current task id, in-flight goal,
partial plan blob) — not a memory item, no `:MemoryItem` label, no embedding.

1. High-Level Architecture (4-Layer Model in One Graph)
All data lives in Neo4j with labels and properties to separate concerns:

Layer 1: Ephemeral / Conversation History → Episode nodes (raw transcript + summary vector)
Layer 2: Working / Session → Observation nodes (short-lived facts) + WorkingState (pluggable, Neo4j default / Redis opt-in)
Layer 3: Long-Term + Preferences → Fact (reified) + Preference nodes
Layer 4: Knowledge Graph + Wisdom → Entity, Insight nodes + temporal relationships
Layer 5 (v1.2): Shared / Procedural / Research → KnowledgeDocument + KnowledgeChunk + Procedure + Research + ResearchChunk
Layer 6: Prospective → Intention nodes (forward-looking commitments; pull-only, never self-firing)

Temporal & Supersede handled via:

Reified Fact nodes (instead of direct properties)
:VALID_DURING relationships or validFrom/validTo + :SUPERSEDES relationships
Bi-temporal support (recordedAt vs validDuring)
:ArchivedRevision chains for non-supersede edits (v1.2)
:AuditEvent append-only log for all lifecycle events (v1.2)

Dreaming = scheduled TS job that runs nightly (or on-demand).
2. Neo4j Schema (Cypher DDL – Run Once)
cypher// 1. Constraints
CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE;
CREATE CONSTRAINT fact_id IF NOT EXISTS FOR (f:Fact) REQUIRE f.id IS UNIQUE;
CREATE CONSTRAINT episode_id IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE;

// 2. Indexes
CREATE TEXT INDEX entity_name_fulltext IF NOT EXISTS FOR (e:Entity) ON e.name;
CREATE FULLTEXT INDEX fact_fulltext IF NOT EXISTS FOR (f:Fact) ON f.content OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}};

// 3. Vector Indexes (2026 native VECTOR type – cosine is best for memory)
CREATE VECTOR INDEX memory_vectors IF NOT EXISTS
FOR (n:Fact|Preference|Insight|Episode)
ON n.embedding
OPTIONS {
  indexConfig: {
    `vector.dimensions`: 1536,           // e.g. text-embedding-3-large or voyage-3
    `vector.similarity_function`: 'cosine',
    `vector.quantization.enabled`: true
  }
};

// 4. Temporal Range Index (fast time queries)
CREATE INDEX fact_temporal IF NOT EXISTS FOR (f:Fact) ON (f.validFrom, f.validTo);
Node Labels & Properties

Entity (Person, Concept, Tool, etc.): id, name, type, embedding
Fact (reified long-term memory): id, content, confidence, importance, validFrom, validTo, recordedAt, embedding, sourceEpisodeId
Preference (user prefs): id, key, value, confidence, validFrom, validTo, embedding
Episode (conversation turn): id, timestamp, rawTranscript, summary, embedding, sessionId
Insight (dreamed wisdom): id, content, embedding
Observation (working memory, TTL 7 days)

Key Relationships

(:Entity)-[:HAS_FACT]->(:Fact)
(:Fact)-[:SUPERSEDES]->(:Fact) (with supersededAt property)
(:Fact)-[:VALID_DURING]->(:TimePeriod) (optional reified time)
(:Episode)-[:CONTAINS]->(:Observation|Fact)
(:Preference)-[:PREFERS]->(:Entity)

3. TypeScript Project Structure
textmemory-layer/
├── src/
│   ├── config/neo4j.ts
│   ├── models/             # Interfaces + Zod schemas
│   ├── repositories/       # Neo4jRepository pattern (type-safe Cypher)
│   ├── services/
│   │   ├── MemoryIngestionService.ts
│   │   ├── RetrievalService.ts     # GraphRAG + hybrid search
│   │   ├── DreamingService.ts      # Consolidation job
│   │   ├── PreferenceService.ts
│   │   └── TemporalService.ts
│   ├── types/              # MemoryLayer types
│   ├── utils/              # embedding, scoring, decay
│   └── index.ts            # exported MemoryLayer class
├── tests/
├── scripts/dream.ts        # nightly cron entrypoint
├── package.json
└── tsconfig.json
Core Dependencies (package.json)
JSON{
  "dependencies": {
    "neo4j-driver": "^5.26.0",
    "@neo4j/graphql": "^7.0.0",           // for optional GraphQL API
    "@neo4j/graphql-ogm": "^7.0.0",
    "openai": "^4.0.0",                   // or voyage-ai, etc. for embeddings
    "zod": "^3.23.0",
    "cron": "^3.1.0",
    "uuid": "^11.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/node": "^22.0.0"
  }
}
4. Core TypeScript Models (src/models.ts)
TypeScriptexport interface Fact {
  id: string;
  content: string;
  embedding: number[];           // native Vector in Neo4j
  confidence: number;            // 0-1
  importance: number;            // 0-1, used in dreaming
  validFrom: Date;
  validTo: Date | null;          // null = still valid
  recordedAt: Date;
  sourceEpisodeId?: string;
}

export interface SupersedePayload {
  oldFactId: string;
  newFactId: string;
  reason: string;
  confidenceDelta: number;
}

// Temporal query helpers
export type TemporalWindow = { from: Date; to: Date };
5. Key Services (High-Level APIs)
MemoryIngestionService

Ingest raw conversation → create Episode
LLM extraction → create/update Fact, Preference, Entity
Automatic supersede detection (LLM + temporal overlap check)

RetrievalService (Hybrid GraphRAG)
TypeScriptasync retrieve(context: {
  queryVector: number[];
  sessionId?: string;
  temporalWindow?: TemporalWindow;
  minImportance?: number;
}) {
  // Cypher 25 SEARCH clause + graph traversal
  const cypher = `
    MATCH (e:Entity)
    WITH e
    MATCH (e)-[:HAS_FACT]->(f:Fact)
    WHERE f.validTo IS NULL OR f.validTo > $now
    SEARCH f IN (VECTOR INDEX memory_vectors FOR $queryVector LIMIT 20)
    WHERE f.importance >= $minImportance
    OPTIONAL MATCH (f)-[:SUPERSEDES]->(old:Fact)
    RETURN f, old, gds.alpha.similarity.cosine(f.embedding, $queryVector) AS score
    ORDER BY score DESC
  `;
  // + full-text fallback + temporal filter
}
DreamingService (Cleanup + Organization)
Run nightly via cron or node scripts/dream.ts:

Collect recent Episodes + Observations
Extract new facts/preferences via LLM (structured output)
Consolidate:
Semantic deduplication (cosine > 0.92 → merge)
Contradiction detection → create :SUPERSEDES
Importance scoring: importance = (recency * 0.4) + (referenceCount * 0.3) + (userExplicit * 0.3)
Decay: Ebbinghaus curve on unreferenced facts

Promote high-importance facts → Insight nodes
Prune low-importance + expired nodes (soft-delete via validTo)

TypeScript// Example dreaming step
async runDreamCycle() {
  const session = driver.session();
  // 1. Extract
  // 2. For each potential fact:
  await session.executeWrite(tx => tx.run(`
    MATCH (f:Fact) WHERE f.validTo IS NULL
    MATCH (new:Fact {id: $newId})
    CREATE (new)-[:SUPERSEDES {reason: $reason, at: $now}]->(f)
    SET f.validTo = $now
  `));
}
PreferenceService
Special handling for Preference nodes with explicit supersede on user confirmation.

6. Size limits and chunking

Motivation. Every embedding backend has a per-input token cap (mxbai-embed-large=512, text-embedding-3-large=8191, voyage-3=32k). The original design embedded a character-truncated summary for every Episode, so long transcripts were silently invisible to Episode-level recall past the first ~500 chars. The current design chunks long inputs and places the chunks in the graph as first-class retrieval units.

Schema additions.
- `(:Chunk {id, text, embedding, tokenCount, position, createdAt, episodeId})`
- `(:Episode)-[:HAS_CHUNK {position}]->(:Chunk)` — every Episode has ≥1 Chunk; short transcripts yield exactly one.
- `(:Chunk)-[:NEXT]->(:Chunk)` — adjacency within one Episode for context expansion.
- `(:Fact)-[:DERIVED_FROM]->(:Chunk)` — dream-extracted Facts cite the exact passage that grounded them.
- `(:SystemState {key:"dream.cursor"})` — persistent dream cursor for time-boxed resumable runs.
- New vector index `chunk_vectors` on `:Chunk(embedding)` at `EMBED_DIM`.

Adapter contract (src/adapters/embeddings/types.ts, src/adapters/llm/types.ts).
- `EmbeddingAdapter.maxInputTokens` — per-input cap. Callers over this MUST chunk.
- `EmbeddingAdapter.countTokens(text)` — default char-ratio heuristic; adapters may install an exact tokenizer.
- `LLMAdapter.maxContextTokens` — total context for prompt+response; the dream service uses ~75% of this for transcript input.
- `LLMAdapter.countTokens(text)` — same heuristic default.
- `LLMAdapter.summarize({ text, targetTokens? })` — used on ingest when the transcript exceeds `SUMMARY_THRESHOLD_TOKENS` and the caller didn't supply a summary.

Ingestion flow (MemoryIngestionService.ingestEpisode).
1. Chunk the `rawTranscript` via the token-aware recursive splitter (paragraph → sentence → word boundaries, greedy pack, optional overlap).
2. Compute the Episode-level summary:
   - If the caller supplied one and it fits, use it verbatim (reject with 400 if over the embedder limit).
   - Else if `countTokens(rawTranscript) > SUMMARY_THRESHOLD_TOKENS`, call `llm.summarize` once.
   - Else embed the transcript directly (no truncation).
3. Batched embed: `[summary, ...chunks]` in one adapter call.
4. Persist Episode + Chunks + HAS_CHUNK + NEXT atomically in a single Neo4j transaction.

Fact ingestion rejects content over the embedder limit with a 400 + explicit token count. No silent truncation anywhere.

Extraction flow (DreamingService.processEpisode).
- Common path: if `countTokens(rawTranscript) ≤ 0.75 * llm.maxContextTokens`, one `extractFacts` call on the whole transcript; facts get `DERIVED_FROM` edges to all chunks of that Episode.
- Pathological path: pack chunks greedily into context-sized groups; one `extractFacts` call per group; facts only link to the chunks in their group.
- Entity upserts are batched via `EntityRepository.upsertMany` (single UNWIND MERGE).

Dream-cycle bounds (DreamingService.runCycle).
- `AsyncMutex` serializes `/dream` invocations with the cron. Second caller receives `409 Conflict` naming the running jobId.
- `DREAM_MAX_EPISODES_PER_RUN` caps episodes per cycle; `DREAM_DEADLINE_MS` is a soft time-box.
- Persistent cursor on `:SystemState {key:"dream.cursor"}` advances after each episode, so a time-boxed or crashed run resumes at the next invocation instead of starting from `lastCompleted`.
- Promote + prune phases skip if the cycle hit its deadline.

Configuration (src/config/env.ts).
| Var | Default | Purpose |
|---|---|---|
| CHUNK_TARGET_TOKENS | 480 | Chunk target (capped by embedder limit) |
| CHUNK_OVERLAP_TOKENS | 50 | Inter-chunk overlap |
| SUMMARY_THRESHOLD_TOKENS | 2000 | Auto-summarize threshold when summary missing |
| SUMMARY_TARGET_TOKENS | 300 | LLM summary length target |
| EMBED_MAX_INPUT_TOKENS | (adapter default) | Override embedder's native cap |
| LLM_MAX_CONTEXT_TOKENS | (adapter default) | Override LLM's native context |
| MAX_BODY_BYTES | 10_000_000 | HTTP bodyLimit (Fastify) |
| DREAM_MAX_EPISODES_PER_RUN | 50 | Cap episodes per dream cycle |
| DREAM_DEADLINE_MS | 300000 | Soft deadline per dream cycle |

HTTP surface changes.
- `POST /facts/batch` arrays capped at 500 entries.
- `POST /dream` returns `409 Conflict` if another run is in progress (includes the running jobId).
- `GET /health` now exposes `embedder.maxInputTokens`, `llm.maxContextTokens`, `dream.running`, `dream.runningJobId`, `dream.lastRunDurationMs`, `dream.backlogEstimate`.
- Body-limit rejections map to `413 Payload Too Large` with a descriptive message.
## OKF vault — readable/portable projection of narrative memory

Research and KnowledgeDocument (the narrative kinds — full `content` retained
on-node) are additionally materialized as markdown files with YAML
frontmatter (`okfVersion: 1`) when `OKF_ENABLED=true`:

```text
{OKF_DIR}/
  projects/{projectId}/research/{id}.md
  projects/{projectId}/documents/{id}.md   # knowledge docs with projectId
  shared/documents/{id}.md                 # knowledge docs without scope
  _trash/<same relative path>              # tombstones (deletedAt/deleteReason)
```

Contract:
- **One write API.** Clients never write the vault; services project into it
  AFTER the graph transaction commits. The graph remains the source of truth
  and the recall authority — the vault is derived output.
- **Log-and-continue.** A vault write/tombstone failure never fails the
  request (the graph already committed). `pnpm okf:sync` is the repair path:
  hash-gated (frontmatter `contentHash` + `updatedAt` vs node), idempotent,
  batched; it also tombstones naturally-lapsed research (`deleteReason:
  expired`) since expiry is enforced on read and no graph-side reaper exists.
  The same sweep runs on `OKF_SYNC_CRON` while `OKF_ENABLED`, so lapsed
  research reaches `_trash/` without a manual run; `pnpm okf:sync` remains the
  on-demand path. Overruns are skipped per-process, but there is no
  cross-process lock — a manual run can race a scheduled tick (writes are
  atomic temp-sibling + rename, so a file is never torn).
- **Frontmatter = identity + provenance** (id, kind, title, scope, source,
  tags, timestamps, contentHash, summary); **body = the retained content**
  (summary + "body not retained" note for pre-retention rows).
- **Path safety.** `projectId` is an arbitrary string: segments are
  sanitized to `[A-Za-z0-9._-]` and suffixed with a short hash of the
  original whenever sanitization changed anything (blocks traversal,
  keeps collisions distinct). Ids are validated UUIDs.
- **Deletion wins over portability.** Soft-delete (and lapsed expiry via
  sync) moves the file to `_trash/` — the live vault never resurrects
  deleted research.
- Research updates route through `revise()` (`:ArchivedRevision` snapshot,
  no `:SUPERSEDES` clone; `projectId`/`userId` immutable). Research bodies
  chunk into `:ResearchChunk` (own vector + fulltext indexes) under the same
  no-silent-truncation rules as knowledge chunks; chunk searches join the
  parent and filter on `expiresAt` so lapsed research cannot resurface.

| Var | Default | Purpose |
|---|---|---|
| OKF_ENABLED | false | Enable vault materialization |
| OKF_DIR | ./.okf-vault | Vault root directory |
| OKF_SYNC_CRON | 30 3 * * * | Scheduled vault sweep (only runs when OKF_ENABLED) |
