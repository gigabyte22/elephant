---
title: "Elephant: data model"
tags: [elephant, memory, data-model, neo4j]
---

Everything Elephant remembers is a node in one Neo4j graph. Every memory node carries the base label
`:MemoryItem` plus its category label, and a `kind` property mirroring the category (used by `kinds=` on recall).
Ids are UUIDv7 (time-ordered). Callers may supply their own id on most writes; episode and fact writes MERGE on
the id, so a retried write with the same id does not duplicate.

## Categories

| Kind (`kind`) | Label | What it is | Who writes it | Lifetime |
|---|---|---|---|---|
| `episode` | `:Episode` | A raw conversation transcript (`rawTranscript`, `summary`, `timestamp`, `agentId`, `sessionId`, optional `origin` = user/cron/event/system/ingest, `participants`, `metadata`) | callers, `POST /episodes` | permanent |
| `chunk` | `:Chunk` | Token-sized slices of an episode (`(:Episode)-[:HAS_CHUNK]->(:Chunk)`, `[:NEXT]` between neighbours), each embedded | Elephant, on ingest | with the episode |
| `fact` | `:Fact` | One-sentence durable belief: `content`, `category`, `confidence` 0-1, `importance` 0-1, `validFrom`/`validTo`, `recordedAt`, `referenceCount`, `lastReferencedAt` | the dream cycle (from episodes) and callers (`POST /facts`) | until superseded, merged, pruned or redacted |
| `preference` | `:Preference` | Versioned key/value about the user (`key`, `value`, `confidence`) | callers only, `PUT /preferences/:key` | new value supersedes old |
| `insight` | `:Insight` | A high-importance fact promoted by the dream cycle | dream cycle only | retired when all its source facts die |
| `observation` | `:Observation` | Short-lived session working memory (`agentId`, `sessionId` required) | callers, `POST /observations` | hard-deleted after `MEMORY_OBSERVATION_TTL_DAYS` (default 7) |
| `knowledge_document` / `knowledge_chunk` | `:KnowledgeDocument`, `:KnowledgeChunk` | Reference documents; body chunked and embedded; file attachments become more chunks | callers, `POST /knowledge/documents` | permanent unless deleted; optional `expiresAt` |
| `research` / `research_chunk` | `:Research`, `:ResearchChunk` | Project-scoped research notes (`projectId` required), full body kept, chunked | callers, `POST /research` | often expiring (`expiresAt`) |
| `procedure` | `:Procedure` | Reusable skill/how-to: `name`, `content`, `whenToUse`, `version`, `successRate`, `invocationCount` | callers, `POST /procedures` | versioned |
| `intention` | `:Intention` | A forward-looking commitment: `content` plus `dueAt` or `triggerHint`, status `pending`/`completed`/`cancelled`/`expired` | callers, `POST /intentions` | until a terminal status |

Supporting nodes that are not memory items: `:Entity` (people, places, tools, concepts; `name`, `type`, an
embedding of the name), `:KnowledgeAttachment` (file metadata + blob id), `:DreamRun` (one per dream cycle),
`:AuditEvent` and `:ArchivedRevision` (history), `:SchemaMigration` (applied migrations), `:SystemState`
(for example `{key:'embedding'}`, which records the embedding model and dimension the stored vectors came from),
and working-state entries (opaque key/value, no embedding).

## Relationships

- `(:Entity)-[:HAS_FACT]->(:Fact)`: facts hang off the entities they mention. Callers name entities with
  `entityNames` on `POST /facts`; the dreamer extracts them. Entities are upserted by normalized name.
- `(:Fact)-[:SUPERSEDES {reason, supersededAt}]->(:Fact)`: the newer fact replaced the older one.
- `(:Fact)-[:DERIVED_FROM]->(:Chunk)`: a dream-extracted fact cites the passage(s) that grounded it.
- `(:Entity)-[:RELATES]->(:Entity)`: subject-predicate-object triples extracted by the dream cycle.
- `(:Entity)-[:SYNONYM]->(:Entity)`: two entity names judged to be the same thing ("NYC" / "New York City"),
  added by entity resolution; non-destructive (nothing is merged).
- `(:KnowledgeDocument)-[:HAS_ATTACHMENT]->(:KnowledgeAttachment)`.

## Vector and full-text indexes

There is one vector index per embedded label, named `<label in lowercase>_vectors` (`fact_vectors`,
`episode_vectors`, `chunk_vectors`, `preference_vectors`, `insight_vectors`, `observation_vectors`,
`knowledgedocument_vectors`, `knowledgechunk_vectors`, `procedure_vectors`, `research_vectors`,
`researchchunk_vectors`, `intention_vectors`, `entity_vectors`), all sized to `EMBED_DIM` and using cosine
similarity, plus English-analyzer full-text indexes on fact content, chunk text, knowledge/research
chunk text, document titles/summaries, procedures and intentions. They are created by the migration
(`scripts/migrate.ts`). Knowledge and research chunks deliberately have separate indexes: a Neo4j vector query
cannot pre-filter, so a shared index would shrink each category's effective top-K.

A vector index only accepts vectors of its own dimension, which is why `EMBED_DIM` must match the embedding model
and why changing the model needs a re-embed (see *Elephant: changing the embedding model*).

## History: audit events and revisions

Mutating writes to facts, preferences, procedures, knowledge documents and research go through one audit path
that, in the same transaction, appends an `:AuditEvent` (`kind` one of `create`, `update`, `supersede`,
`soft_delete`, `prune`, `promote`, `archive`; `targetId`, `targetKind`, `actor`, `payload`, `at`) and, for
edits, snapshots the previous state into an `:ArchivedRevision`. Dream-cycle events carry `actor: "dreamer"`
and the dream run id. Read them with `GET /audit/:targetId` (revisions + events for one item) or
`GET /audit?actor=&from=&to=&limit=` (global log). This is how to answer "why does the assistant believe X?".

## Episodes in more detail

- A transcript is split into chunks of about `CHUNK_TARGET_TOKENS` (480) with `CHUNK_OVERLAP_TOKENS` (50) overlap,
  capped by the embedder's input limit, and every chunk is embedded. Nothing is silently truncated.
- The episode summary: a caller-supplied `summary` is used as is; a transcript under `SUMMARY_THRESHOLD_TOKENS`
  (2000) is its own summary; a longer one gets a clipped-head placeholder marked `summaryProvisional`, which the
  next dream cycle replaces with an LLM summary and re-embeds (unless `INGEST_DEFER_SUMMARY=false`, which
  summarizes inline).
- `timestamp` (event time) defaults to now; pass it when importing historical conversations, because facts the
  dreamer extracts take it as their `validFrom`.
- `participants: [{label, userId?}]` plus turns written as `USER(<label>):` lets the dreamer attribute each fact
  to the right person's `userId`; facts about the world or the group go to the shared (null user) bucket.
- `metadata` is a small string map (max 16 entries) stored for provenance only: never indexed, searched or scored.
- `isolated: true` opts the episode out of cross-scope dedup against the unscoped bucket.

The dream bookkeeping lives on the episode itself: `dreamedAt` (done), `dreamAttempts`, `dreamNextAttemptAt`
(backoff after a failure). See *Elephant: the dream cycle*.
