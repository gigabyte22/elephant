---
title: "Elephant: troubleshooting"
tags: [elephant, troubleshooting, operations]
---

Start every investigation with the two cheapest signals:

```bash
curl -s http://127.0.0.1:18790/health | jq .data          # no token needed
cd /home/cerebro/cerebro-stack && bin/stack logs elephant --no-follow
```

## elephant.service keeps restarting

The unit has `Restart=always` with a 5 s delay and runs the migration before the server, so any startup error
becomes a restart loop. Read the first error in the journal:

| Log shows | Cause | Fix |
|---|---|---|
| `Invalid environment configuration:` + lines | a bad or missing variable: token under 8 chars, provider without its key/URL (`ANTHROPIC_API_KEY required when MEMORY_LLM_PROVIDER=anthropic`, `LLAMACPP_BASE_URL required ...`), retrieval weights not summing to 1.0, a malformed URL | fix `.env` (or `stack.env` + `bin/stack configure` for stack-owned keys); `bin/stack configure` re-validates |
| `The configured embedder does not match the stored vectors: ...` (`[serve] fatal:`) | embedding provider/model/`EMBED_DIM` changed under an existing graph | restore the old settings, or re-embed: *Elephant: changing the embedding model* |
| connection refused / `ServiceUnavailable` on bolt 7687 | Neo4j not running | `bin/stack up neo4j`; `docker logs elephant-neo4j`; check docker itself |
| Neo4j authentication failure | `NEO4J_PASSWORD` in `.env` differs from the password Neo4j has stored. The container only takes `NEO4J_AUTH` when its data volume is first created, so changing the secret later does not change Neo4j's password | put the original password back in the secret, or change it inside Neo4j to match |
| `EADDRINUSE` | another process on `MEMORY_PORT` | find it (`ss -ltnp | grep 18790`) and stop it |
| `tsx` / module not found | dependencies missing after a checkout move | `bin/stack install` (runs `pnpm install --frozen-lockfile` in the checkout) |

## `/health` says `neo4j: false`

The service is up but cannot reach Neo4j: container stopped, restarting, or out of memory. `bin/stack status`,
`docker ps -a | grep elephant-neo4j`, `docker logs elephant-neo4j`. In that state `backlogEstimate` and the
schema fields are null.

## 401 unauthorized

The caller's token differs from `MEMORY_SERVICE_TOKEN`. In the stack both sides come from
`ELEPHANT_SERVICE_TOKEN` in `$STACK_ROOT/secrets.env`; after rotating it, run `bin/stack configure` and restart
both Elephant and Cerebro.

## "I told the assistant something and it doesn't remember"

- Conversations become facts only when the dream cycle has processed them. Check `/health.data.dream.lastRun`
  and `backlogEstimate`; trigger a cycle with `POST /dream` (see *Elephant: the dream cycle*). Facts saved
  explicitly (`POST /facts`) are searchable immediately.
- `deadLetteredEpisodes` > 0: those episodes failed extraction 3 times and were dropped from the queue. Look for
  `[dream <id>] episode <id> failed (attempt n/3, dead-lettered)` in the log, fix the LLM, then re-queue them
  (procedure in *Elephant: the dream cycle*).
- Lines like `--- raw response (... chars) ---` after an extraction error mean the LLM returned unparseable JSON
  (common with small local models). Those groups are skipped; a stronger model or smaller inputs help.
- The fact may have been superseded, merged, pruned or redacted: `GET /audit/<factId>` and
  `GET /recall?q=...&includeSuperseded=1` show it.

## Recall returns nothing or the wrong things

- Opt-in categories are off by default: knowledge (`includeKnowledge=1`), research, procedures, intentions and
  observations. `kinds=` only filters; it does not switch a category on.
- Scope: `projectScope/userScope=filter|strict` hides items in other scopes; `strict` also hides shared ones.
  Omitting an axis spans all scopes. See *Elephant: memory scopes*.
- `asOf` in the past or `from`/`to` restrict facts by valid time.
- Add `debug=1` and read `data.trace`: per-stage timings, candidates seen, and source diagnostics. A source marked
  `starved` (also logged as a warning) means the filter was so selective that even the widest vector search found
  too few survivors; raise `RETRIEVAL_ANN_MAX_K` if this is routine.
- Do not threshold on `score` (it is relative within one result set); use `vectorScore`.
- `embedModel` != `schemaEmbedModel` or `embedder.dim` != `schemaVectorDim` in `/health`: vectors are not
  comparable; re-embed.

## Dream problems

| Symptom | Meaning / fix |
|---|---|
| `POST /dream` -> 409 `dream already running as job <id>` | a cycle is in progress (cron or manual). Poll `GET /dream/<id>`; do not retry in a loop |
| log `[dream-cron] skipped tick, run <id> still in progress` | harmless; the previous cycle was still draining |
| `/health` `running: false` but a run shows `running` in `/dashboard/api/dreams` | the process died mid-run; the row is marked failed at the next boot once it is older than max(4 x `DREAM_DEADLINE_MS`, 1 h) |
| `backlogEstimate` keeps growing | cycles are slower than episode arrival: LLM slow or failing, or the cron too infrequent. Raise `DREAM_MAX_EPISODES_PER_RUN`/`DREAM_DEADLINE_MS`, run the cron more often, or use a faster model |
| facts are created but nothing is ever merged, promoted or pruned | every cycle hits its deadline; the graph-wide passes (entity resolution, supersede sweep, consolidation, promotion, prune) only run when the episode loop finishes in time. Raise `DREAM_DEADLINE_MS` or lower `DREAM_MAX_EPISODES_PER_RUN` |
| run `failed` with an error | `GET /dream/<id>` shows `error`; usually the LLM endpoint or Neo4j |

## Slow writes or recall on a local GPU (contention)

On a local deployment the LLM (llama.cpp), the embedder (Ollama) and the vision model often share one GPU. The
service is built so that no LLM call sits on the request path: episode summaries, the contradiction check on
`POST /facts`, and attachment OCR/transcription are all deferred to the dream cycle or the extraction worker,
and the worker handles one attachment at a time. Embedding still happens on every write and every recall query,
so when the GPU is busy with a long dream cycle or OCR job, those embeddings queue and requests slow down. To keep
it that way:

- leave `INGEST_SUPERSEDE_MODE=dream`, `INGEST_DEFER_SUMMARY=true`, `RETRIEVAL_ENABLE_RERANK=false` and
  `RETRIEVAL_PPR_USE_RECOGNITION_FILTER=false` (each of the alternatives puts an LLM call on the request path);
- schedule `MEMORY_DREAM_CRON` for quiet hours, or bound each run with `DREAM_MAX_EPISODES_PER_RUN` /
  `DREAM_DEADLINE_MS`;
- run attachment backfills when the assistant is idle.

Knowledge and research ingestion still summarize long documents inline, so a large `POST /knowledge/documents`
can take as long as an LLM summary.

## Attachments

- Stuck `pending`: the worker processes one every 2 minutes; a long queue simply takes time. `/health.extraction`
  shows `pending` and `deadLettered`. Log lines start with `[extraction-worker]`.
- `skipped`: no OCR/transcription provider configured. Configure it (*Elephant: attachment OCR and transcription
  settings*), then `pnpm backfill:attachment-extraction --yes`.
- `truncated`: output hit `KNOWLEDGE_VISION_MAX_TOKENS` or a scan exceeded `KNOWLEDGE_PDF_OCR_MAX_PAGES`; raise it
  and re-run the backfill.
- 413 on upload: file over `KNOWLEDGE_MAX_ATTACHMENT_BYTES` (25 MiB).
- A settings change in `.env` has no effect: a value stored through the admin API wins; check `source` in
  `GET /admin/settings/knowledge-media` and `unset` it.

## Other

- `/dashboard` returns 503 "dashboard build not found": build it (*Elephant: operations*).
- 413 on other routes: body over `MAX_BODY_BYTES` (10 MB). `POST /facts/batch` takes at most 500 facts.
- 400 `includeObservations requires sessionId`-style errors: observations recall needs `sessionId`, and `kinds`
  must include `observation` when `includeObservations` is set.
- OKF sync exits 1 with "the reap was skipped by the empty-graph guard": the graph returned no documents while the
  vault has files; check `NEO4J_URI` and `OKF_DIR` before using `--force-reap`.
