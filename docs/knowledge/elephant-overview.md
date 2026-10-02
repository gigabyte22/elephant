---
title: "Elephant: overview and role in the stack"
tags: [elephant, overview, memory, ports]
---

Elephant is the long-term memory service behind Cerebro. It is a single Node.js (TypeScript, run with `tsx`, no
build step) HTTP service that stores everything in **Neo4j**, and Neo4j is its only datastore: Neo4j's native
vector indexes, full-text indexes and temporal properties replace a separate vector database, SQL store and queue.
The only state outside Neo4j is the attachment blob directory, the encrypted admin-settings file and (optionally)
the OKF markdown vault.

## What it does, in one paragraph

Callers POST raw conversation **episodes**. Elephant chunks and embeds them immediately (no LLM call on the
write). A scheduled **dream cycle** later reads new episodes with an LLM, extracts **facts**, links them to
**entities**, detects contradictions (supersede), merges fragments (consolidation), promotes important facts to
**insights**, and soft-prunes stale facts along a forgetting curve. `GET /recall` searches the whole graph
(vector + full-text, fused by reciprocal rank fusion, then blended with importance/recency/confidence/reference
count) and returns a ranked, scoped working set. Alongside that it stores preferences, knowledge documents (with
file attachments), research notes, procedures (skills), intentions (reminders), session observations and a
working-state key/value store. Every mutation of a fact, preference, procedure, knowledge document or research
item leaves an audit event and, for edits, a revision snapshot.

## How it runs on this host

| Piece | Unit | Listens on | Notes |
|---|---|---|---|
| Neo4j 5.26 community + APOC + GDS | `elephant-neo4j.service` (runs `docker compose up -d --force-recreate neo4j` in the elephant checkout; container name `elephant-neo4j`) | 127.0.0.1:7474 (HTTP/browser), 127.0.0.1:7687 (Bolt) | data in named docker volumes, which survive the recreate |
| Elephant service | `elephant.service` (`ExecStartPre` runs `scripts/migrate.ts`, then `scripts/serve.ts`; `Restart=always`, 5 s) | 127.0.0.1:`MEMORY_PORT` (stack: `ELEPHANT_PORT`, default 18790) | config from `.env` in the checkout |

- Checkout: `/home/cerebro/stack/elephant` (`$STACK_ROOT/elephant`); config: `/home/cerebro/stack/elephant/.env`
  (rendered by `bin/stack configure`, mode 0600).
- Attachment blobs: `$STACK_ROOT/data/elephant-blobs` (`KNOWLEDGE_BLOB_DIR`).
- Encrypted admin settings: `$STACK_ROOT/data/elephant-state/settings.enc` (`ELEPHANT_STATE_DIR`).
- OKF vault (when `OKF_ENABLED=true`): `OKF_DIR`, default `./.okf-vault` inside the checkout.
- Start order in the stack: neo4j -> elephant -> agentsmith -> tools -> relay -> cerebro. `bin/stack up` waits up
  to 120 s for Neo4j and 300 s for elephant's `/health`.

## Health and auth

- `GET /health` needs **no token**. It reports `neo4j` (reachable), the LLM and embedder names and limits,
  `schemaVectorDim` vs `embedder.dim`, `embedModel` vs `schemaEmbedModel`, dream status (`lastRun`, `running`,
  `runningJobId`, `backlogEstimate`, `deadLetteredEpisodes`) and the attachment extraction queue
  (`extraction.pending`, `extraction.deadLettered`).
- Every other route needs `Authorization: Bearer <MEMORY_SERVICE_TOKEN>` (at least 8 characters). In the stack the
  same secret is `ELEPHANT_SERVICE_TOKEN` in `$STACK_ROOT/secrets.env`, and Cerebro receives it as its
  `ELEPHANT_SERVICE_TOKEN`. A wrong or missing token gets `401 {"ok":false,"error":"unauthorized"}`.
- The dashboard shell under `/dashboard` loads without a token; its data API (`/dashboard/api/*`) needs it.

```bash
curl -s http://127.0.0.1:18790/health | jq
TOKEN=$(sed -n 's/^MEMORY_SERVICE_TOKEN=//p' /home/cerebro/stack/elephant/.env)
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:18790/recall?q=coffee&limit=5" | jq
```

## Who uses it

- **Cerebro** is the main caller (`MEMORY_ADAPTER=elephant`, `ELEPHANT_URL`, `ELEPHANT_SERVICE_TOKEN` in its
  `.env`). Its memory adapter writes episodes, facts, observations, knowledge documents, research, procedures,
  intentions and working state, and calls `/recall`. Cerebro's Connections page (the "memory-vision" card) reads
  and writes Elephant's attachment OCR/transcription settings through `/admin/settings/knowledge-media`.
- `bin/stack doctor` checks `/health`; `bin/stack backup` dumps the graph with `scripts/backup-neo4j.py`.
- Optional adapters in the repo: an MCP server, an OpenClaw plugin and a hermes-agent provider, all thin clients of
  the same HTTP API (see *Elephant: client package and adapters*).

## Design rules worth knowing

- **No LLM on the synchronous request path.** Writes return after chunking + embedding. Summaries of long
  transcripts, contradiction checks on directly written facts, and OCR/transcription of attachments are deferred
  to background jobs. Model work happens in the dream cycle, the attachment worker and opt-in recall features
  (rerank, PageRank recognition filter), which all default off and degrade to no-ops on failure.
- **Soft delete by default.** Forgetting closes a validity interval (`validTo`) rather than deleting nodes; the few
  hard deletes are listed in *Elephant: time, supersede and forgetting*.
- **Pull-only.** Elephant never calls out to its callers; it does not fire reminders (intentions) itself.
- Elephant has no user accounts. One bearer token grants everything; separation between users/projects is by
  **scope** fields that callers send (see *Elephant: memory scopes*).
