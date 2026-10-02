---
title: "Elephant: security model and limits"
tags: [elephant, security, auth, privacy]
---

Elephant stores raw conversation transcripts, everything extracted from them, uploaded documents and their
embeddings. Treat the Neo4j database, the blob directory, the settings store and the OKF vault as being as
sensitive as the conversations themselves.

## Trust boundaries

- **One shared bearer token** (`MEMORY_SERVICE_TOKEN`, at least 8 characters) authorizes every route. Holders of
  the token can read, write and delete any memory. There are no per-user keys and no roles. In the stack the
  token is `ELEPHANT_SERVICE_TOKEN` in `$STACK_ROOT/secrets.env`, given to Elephant and Cerebro only.
- **Unauthenticated**: `GET /health` (status and model names, no memory content) and the static dashboard shell
  under `/dashboard` (HTML/JS only; its data API `/dashboard/api/*` requires the token).
- **Network**: the service binds `127.0.0.1` (`MEMORY_BIND`), Neo4j publishes 7474/7687 on 127.0.0.1 only, and
  compose refuses to start Neo4j without `NEO4J_PASSWORD`. Never bind either to a public interface; if remote
  access is needed, put a TLS reverse proxy in front, because the token is the only authentication layer.
- **Scope is not authentication.** Project/user separation relies on the caller sending the right
  `projectId`/`userId` and scope modes. Id-addressed routes refuse cross-scope ids with 404 when the caller
  declares its scope, but a caller that declares no scope is unrestricted. Cerebro is the component that decides
  which scope each agent and user gets.

## Data leaving the host

- The **LLM** (`MEMORY_LLM_PROVIDER`) receives transcripts during dream extraction, document text for summaries,
  and fact text for contradiction checks, consolidation and (if enabled) reranking. With `anthropic` or a hosted
  `openai` this leaves the machine; with `llamacpp` or a local OpenAI-compatible server it does not.
- The **embedder** receives every text that gets embedded (episodes, facts, queries, documents).
- **Attachment OCR/transcription** sends file bytes to the configured vision/transcription endpoint, and is off
  until explicitly configured (`auto` only turns on with dedicated `KNOWLEDGE_VISION_*`/`KNOWLEDGE_TRANSCRIBE_*`
  credentials). The boot log states where attachments go.
- The dream cycle shows the LLM up to 8 "already known" related facts as context, taken only from the episode's
  own scope bucket (plus the unscoped bucket unless the episode is `isolated`), never from other projects.

## Secrets at rest

- `.env` (0600 in the stack) holds the token, `NEO4J_PASSWORD`, provider keys and `ELEPHANT_SETTINGS_KEY`.
- Runtime OCR/transcription credentials set through `/admin/settings/knowledge-media` are stored AES-256-GCM
  encrypted in `ELEPHANT_STATE_DIR/settings.enc`; secret values (`*_API_KEY`) are write-only over the API and never
  returned.
- The dashboard keeps the pasted token in the browser's localStorage.
- Backups contain the full graph in plain Cypher (gzip) and the blobs; `bin/stack backup` writes them 0700/0600.

## Destructive operations

Only a few things hard-delete (expired observations, opted-in research retention, `?purge=true` document deletes,
attachment deletes, `okf:sync --purge`, and the operator scripts `wipe`, `rebuild:facts`). Back up before any
operator script. Never run the test suites against a deployed checkout: the integration tests delete all data in
whatever database `.env` points to.

## Limits

| Limit | Value |
|---|---|
| HTTP body | `MAX_BODY_BYTES`, 10 MB |
| Attachment | `KNOWLEDGE_MAX_ATTACHMENT_BYTES`, 25 MiB |
| `POST /facts/batch` | 500 facts |
| Episode `metadata` / research `metadata` | 16 / 20 entries, keys <= 64 chars, values <= 512 chars |
| Episode `participants` | 32 |
| Recall `limit` | 100 |
| List `limit` | 200 (audit, timeline, observations: 500) |
| Fact/summary text | must fit the embedder's input limit, otherwise 400 (no silent truncation) |

Out of scope by design: denial of service through unbounded ingestion or LLM cost, and running with Neo4j or the
service exposed to an untrusted network. Elephant is single-node; there is no replication.
