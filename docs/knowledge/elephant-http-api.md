---
title: "Elephant: HTTP API reference"
tags: [elephant, api, http, reference]
---

Elephant's whole surface is an HTTP/JSON API on `http://127.0.0.1:18790` (port `MEMORY_PORT`; loopback only).
Every route except `GET /health` and the dashboard shell needs `Authorization: Bearer <MEMORY_SERVICE_TOKEN>`.

## Envelope and errors

Every response is `{"ok": true, "data": ...}` or `{"ok": false, "error": "<message>"}`. The single exception is
`GET /knowledge/attachments/:blobId`, which streams the raw file.

| Status | Meaning |
|---|---|
| 400 | validation failed (the message names the field) |
| 401 | missing or wrong bearer token (`"unauthorized"`) |
| 404 | not found, **or out of the caller's declared scope** (never 403) |
| 409 | conflict: a dream is already running; a redacted fact id was re-posted |
| 413 | body over `MAX_BODY_BYTES` (10 MB) or attachment over its limit |
| 500 | `"internal error"`; details only in the service log |

Writes accept a client-supplied `id` (UUID) so a retried write does not duplicate. Dates are ISO-8601 strings.
Most writes take an optional `actor` that is recorded in the audit trail. Query booleans accept `true/1/yes/on`.

## Routes

**Health and dreaming**

| Route | Purpose |
|---|---|
| `GET /health` | no auth; Neo4j reachability, LLM/embedder names and limits, `schemaVectorDim`, `embedModel`/`schemaEmbedModel`, `dream{lastRun,lastRunDurationMs,running,runningJobId,backlogEstimate,deadLetteredEpisodes}`, `extraction{pending,deadLettered}`, capability flags `episodeMetadata`, `researchMetadata`, `researchSimilar` |
| `POST /dream` | start a dream cycle now -> `{jobId}`; 409 if one is running |
| `GET /dream/:jobId` | status and counters of one run |

**Conversation memory**

| Route | Purpose |
|---|---|
| `POST /episodes` | `{agentId, sessionId, rawTranscript, summary?, timestamp?, projectId?, userId?, origin?, participants?, isolated?, metadata?, id?}` -> `{episodeId}`; chunked and embedded, facts extracted later by dreaming |
| `POST /facts` | `{content, category?, confidence?, importance?, validFrom?, entityNames?, sourceEpisodeId?, projectId?, userId?, agentId?, sessionId?, actor?, id?}`; content over the embedder's input limit is rejected with 400 |
| `POST /facts/batch` | `{facts: [...]}`, 1-500 |
| `GET /facts/:id` | one fact; `?projectId=&userId=` scope guard |
| `POST /facts/:id/supersede` | `{newFactId, reason}`; closes `:id` at event time |
| `DELETE /facts/:id` | redaction: invisible everywhere afterwards |
| `GET /recall` | hybrid search; see *Elephant: how recall works* |
| `GET /timeline?at=` | valid-time snapshot: facts valid at `at` (optionally for one `entityId`; `limit` <= 500), plus the value of one preference at that instant when `preferenceKey` is given |
| `GET /entities?name=` / `GET /entities/:id` | fuzzy entity lookup / entity with its facts |
| `GET /preferences`, `GET /preferences/:key`, `PUT /preferences/:key` | versioned key/value; PUT body `{value, confidence?, actor?, projectId?, userId?}` supersedes the previous value |
| `POST /observations`, `GET /observations?sessionId=` | session working memory `{agentId, sessionId, content, projectId?, userId?}`, kept `MEMORY_OBSERVATION_TTL_DAYS` |

**Documents, research, procedures, intentions**

| Route | Purpose |
|---|---|
| `POST/GET/PUT/DELETE /knowledge/documents[/:id]` | reference documents; DELETE `?purge=true` drops chunks and blobs |
| `POST /knowledge/documents/:id/attachments` | `{filename, mimeType, dataBase64}`; text extracted inline or queued |
| `DELETE /knowledge/documents/:id/attachments/:attachmentId` | remove one attachment |
| `GET /knowledge/attachments/:blobId` | raw bytes |
| `POST/GET/PUT/DELETE /research[/:id]`, `GET /research/:id/similar` | project-scoped notes (`projectId` required) |
| `POST /procedures` | `{name, content, whenToUse, scope?, expiresAt?}`; `whenToUse` + content are embedded so recall can suggest it |
| `GET /procedures?name=` / `GET /procedures` / `GET /procedures/:id` | exact lookup by name, list, or by id |
| `PUT /procedures/:id` | update content/whenToUse (creates a new version linked by `:SUPERSEDES`) or stats (`successRate`, `invocationCount`, `lastSuccessAt`) |
| `DELETE /procedures/:id` | soft delete |
| `POST /intentions` | `{content, dueAt? or triggerHint?, recurring?, schedule?, importance?, scope?, sourceEpisodeId?, sourceFactId?}` |
| `GET /intentions?status=`, `GET /intentions/due?before=`, `GET /intentions/:id` | list / due-or-overdue (for boot-time reconciliation, not polling) / one |
| `POST /intentions/:id/complete`, `/cancel`, `/fired` | terminal states, or record a firing without closing. Elephant never fires intentions itself; the caller owns the clock |

**Working state, audit, admin, dashboard data**

| Route | Purpose |
|---|---|
| `POST /state` | `{scope:{agentId, sessionId?, userId?, projectId?}, key, value, ttlSec?}`; opaque live state, not a memory item |
| `GET /state/:key?agentId=...`, `DELETE /state/:key?agentId=...`, `GET /state?agentId=...&prefix=` | read, delete, list keys |
| `GET /audit/:targetId` | revisions and audit events for one item |
| `GET /audit?actor=&from=&to=&limit=` | global audit log (limit <= 500) |
| `GET/PUT /admin/settings/knowledge-media` | runtime OCR/transcription settings; see *Elephant: attachment OCR and transcription settings* |
| `GET /dashboard/api/...` | read-only JSON for the dashboard: `stats`, `timeline`, `facts/top`, `facts/categories`, `facts/retention`, `entities/top`, `entities/types`, `episodes/origins`, `documents`, `graph/search`, `graph/neighborhood`, `graph/overview`, `dreams?limit=`, `supersede-chains?factId=`, `audit`, `research/:id/markdown`, `knowledge/documents/:id/markdown` |

Id-addressed routes accept `?projectId=&userId=` and answer 404 for an item in another scope; list routes take
the scope ids and mode params described in *Elephant: memory scopes*.

## Examples

```bash
TOKEN=$(sed -n 's/^MEMORY_SERVICE_TOKEN=//p' /home/cerebro/stack/elephant/.env)
E=http://127.0.0.1:18790
H="Authorization: Bearer $TOKEN"

# Save a fact about a user and read it back
curl -s -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"content":"Alice prefers espresso over drip coffee","importance":0.6,"entityNames":["Alice"],"userId":"alice","actor":"operator"}' \
  $E/facts | jq '.data.id'

# Why does the assistant believe something? (history of one fact)
curl -s -H "$H" $E/audit/<factId> | jq

# Forget a fact (redaction)
curl -s -X DELETE -H "$H" $E/facts/<factId> | jq

# What is due before Friday?
curl -s -H "$H" "$E/intentions/due?before=2026-10-09T00:00:00Z" | jq
```

The typed TypeScript client `@kainappsinc/elephant-client` wraps every route (see *Elephant: client package and
adapters*). The full contract lives in the repo's `EXPECTED.md`.
