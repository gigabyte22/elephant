---
title: "Elephant: configuration"
tags: [elephant, configuration, env]
---

Elephant reads all configuration from environment variables, loaded from `.env` in its checkout
(`/home/cerebro/stack/elephant/.env`) at start. The file is validated as a whole: one invalid value and the
service (and the migration in `ExecStartPre`) refuses to start, printing `Invalid environment configuration:`
with one line per problem. Changes take effect on the next restart, except the attachment OCR/transcription
group, which can also be changed live (see *Elephant: attachment OCR and transcription settings*).
`/home/cerebro/stack/elephant/.env.example` lists every variable with its comment and default.

## Who owns which keys (stack install)

`bin/stack configure` (also run by `bin/stack upgrade`) rewrites a fixed set of keys in Elephant's `.env` from
`stack.env` and `secrets.env`, and keeps every other line untouched. A blank value in `stack.env` removes the key,
so Elephant's default applies.

| Elephant variable | Set from (stack) |
|---|---|
| `MEMORY_PORT`, `MEMORY_BIND` | `ELEPHANT_PORT` (18790), always `127.0.0.1` |
| `MEMORY_SERVICE_TOKEN` | secret `ELEPHANT_SERVICE_TOKEN` (shared with Cerebro) |
| `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` | `bolt://127.0.0.1:7687`, `neo4j`, secret `NEO4J_PASSWORD` |
| `MEMORY_LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_EXTRACTION_MODEL`, `ANTHROPIC_DREAMING_MODEL` | `ELEPHANT_LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `ELEPHANT_ANTHROPIC_*` |
| `MEMORY_EMBED_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_EMBED_MODEL`, `OPENAI_EXTRACTION_MODEL`, `EMBED_DIM` | `ELEPHANT_EMBED_PROVIDER`, `ELEPHANT_OPENAI_*`, `ELEPHANT_EMBED_DIM` |
| `LLAMACPP_BASE_URL`, `LLAMACPP_MODEL`, `OLLAMA_BASE_URL`, `OLLAMA_EMBED_MODEL` | `ELEPHANT_LLAMACPP_*`, `ELEPHANT_OLLAMA_*` |
| `MEMORY_DREAM_CRON` | `ELEPHANT_DREAM_CRON` |
| `KNOWLEDGE_BLOB_DIR`, `ELEPHANT_STATE_DIR`, `ELEPHANT_SETTINGS_KEY` | `$STACK_ROOT/data/elephant-blobs`, `$STACK_ROOT/data/elephant-state`, secret |
| `BACKUP_DIR`, `BACKUP_KEEP` | `$BACKUP_DIR/neo4j-daily`, `BACKUP_KEEP` (used only by the optional elephant-backup timer) |

So: change those through `stack.env` and run `bin/stack configure` then restart Elephant; edit anything else
directly in Elephant's `.env` and restart. `bin/stack configure` also validates the file with Elephant's own loader.

## Providers

| Variable | Default | Notes |
|---|---|---|
| `MEMORY_LLM_PROVIDER` | `anthropic` | `anthropic`, `openai` (also any OpenAI-compatible server via `OPENAI_BASE_URL`), `llamacpp` |
| `ANTHROPIC_EXTRACTION_MODEL` / `ANTHROPIC_DREAMING_MODEL` | `claude-sonnet-4-6` / `claude-opus-4-7` | needs `ANTHROPIC_API_KEY` |
| `OPENAI_EXTRACTION_MODEL` | `gpt-4.1-mini` | needs `OPENAI_API_KEY` or `OPENAI_BASE_URL` |
| `LLAMACPP_BASE_URL`, `LLAMACPP_MODEL` | -, `qwen3.5:9b-turboquant` | llama.cpp server's OpenAI API (`/v1` appended if missing); context assumed 8192 tokens |
| `MEMORY_EMBED_PROVIDER` | `openai` | `openai`, `voyage` (`VOYAGE_API_KEY`, model voyage-3), `ollama` (`OLLAMA_BASE_URL`) |
| `OPENAI_EMBED_MODEL` / `OLLAMA_EMBED_MODEL` | `text-embedding-3-large` / `nomic-embed-text` | |
| `EMBED_DIM` | 1536 | **must equal the embedding model's output size** (for example nomic-embed-text 768, mxbai-embed-large 1024, text-embedding-3-small 1536, text-embedding-3-large 3072; the defaults `text-embedding-3-large` + 1536 do not match, so set both). For models whose name starts with `text-embedding-3`, `EMBED_DIM` is also sent to the API as `dimensions`, so those models return vectors of exactly that size; other models are called without it. It sizes the vector indexes at migrate time; see *Elephant: changing the embedding model* |
| `EMBED_MAX_INPUT_TOKENS` | adapter default | per-input cap (ollama: 512, nomic-embed-text 2048) |

The provider/key pairs are cross-checked at start (for example `MEMORY_LLM_PROVIDER=llamacpp` without
`LLAMACPP_BASE_URL` fails).

## Service, limits, chunking

| Variable | Default | Notes |
|---|---|---|
| `MEMORY_PORT`, `MEMORY_BIND` | 18790, `127.0.0.1` | keep loopback; the token is the only auth |
| `MEMORY_SERVICE_TOKEN` | required, >= 8 chars | |
| `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE` | `bolt://localhost:7687`, `neo4j`, required, `neo4j` | |
| `MAX_BODY_BYTES` | 10000000 | HTTP body limit |
| `CHUNK_TARGET_TOKENS`, `CHUNK_OVERLAP_TOKENS` | 480, 50 | |
| `SUMMARY_THRESHOLD_TOKENS`, `SUMMARY_TARGET_TOKENS` | 2000, 300 | longer texts get an LLM summary |
| `INGEST_DEFER_SUMMARY` | true | episode summaries are made by the dreamer, not on `POST /episodes` |
| `INGEST_SUPERSEDE_MODE` | `dream` | `inline` runs the contradiction check (an LLM call) inside `POST /facts` |
| `WORKING_STATE_BACKEND`, `REDIS_URL` | `neo4j` | `redis` needs `REDIS_URL` |
| `LOG_LEVEL` | `info` | Fastify log level (read directly, not validated) |

## Dream cycle

`MEMORY_DREAM_CRON` (`0 3 * * *`), `DREAM_MAX_EPISODES_PER_RUN` (50), `DREAM_DEADLINE_MS` (300000),
`DREAM_MAX_ATTEMPTS` (3), `DREAM_RETRY_BACKOFF_BASE_MS` (60000), `DREAM_DEDUP_THRESHOLD` (0.92),
`DREAM_SUPERSEDE_VECTOR_THRESHOLD` (0.85), `DREAM_SUPERSEDE_SWEEP_MAX_FACTS` (50), `DREAM_SUMMARY_SWEEP_MAX_EPISODES`
(20), `DREAM_PROMOTE_INSIGHT_IMPORTANCE` (0.85), `DREAM_INSIGHT_DEDUP_THRESHOLD` (0.92), `DREAM_INSIGHT_DEDUP_K`
(50), `DREAM_INSIGHT_RETIRE_BATCH_LIMIT` (1000), `DREAM_CROSS_SCOPE_DEDUP` (true), `DREAM_CROSS_SCOPE_SUPERSEDE`
(false), `DREAM_ENABLE_RELATION_EXTRACTION` (true), `DREAM_RELATION_MIN_CONFIDENCE` (0.6),
`DREAM_ENABLE_ENTITY_RESOLUTION` (true), `DREAM_ENTITY_SYNONYM_THRESHOLD` (0.9), `DREAM_ENTITY_SYNONYM_CANDIDATES`
(5), `DREAM_ENABLE_CONSOLIDATION` (true), `DREAM_CONSOLIDATION_MAX_CLUSTERS_PER_RUN` (10),
`DREAM_CONSOLIDATION_MAX_CLUSTER_SIZE` (6), `DREAM_CONSOLIDATION_MIN_SIMILARITY` (0.8),
`DREAM_CONSOLIDATION_MIN_ENTITY_FACTS` (3). Pruning: `DREAM_PRUNE_WINDOW_DAYS` (30), `DREAM_PRUNE_BATCH_LIMIT`
(1000), `DREAM_PRUNE_IMPORTANCE_EXEMPT` (0.75), `DREAM_PRUNE_RETENTION_FLOOR` (0.05). Meaning of each: see
*Elephant: the dream cycle* and *Elephant: time, supersede and forgetting*.

## Retrieval

| Variable | Default | Notes |
|---|---|---|
| `RETRIEVAL_WEIGHT_RRF`, `_IMPORTANCE`, `_CONFIDENCE`, `_RECENCY`, `_REF_COUNT` | 0.5, 0.2, 0.1, 0.1, 0.1 | **must sum to 1.0 (+-0.01)** or the service will not start |
| `RETRIEVAL_RRF_K` | 60 | RRF constant |
| `RETRIEVAL_RECENCY_HALF_LIFE_DAYS` | 30 | |
| `RETRIEVAL_OWN_AGENT_BOOST`, `RETRIEVAL_SAME_SESSION_BOOST` | 1.15, 1.05 | multipliers |
| `RETRIEVAL_ENABLE_CHUNKS`, `RETRIEVAL_ENABLE_SIBLING_EXPANSION` | true, true | |
| `RETRIEVAL_SIBLING_BUDGET`, `RETRIEVAL_CHUNK_NEIGHBOR_RADIUS` | 20, 1 | |
| `RETRIEVAL_ENABLE_RERANK`, `RETRIEVAL_RERANK_TOP_K`, `RETRIEVAL_RERANK_KEEP_K` | false, 20, 10 | an LLM call per recall when on |
| `RETRIEVAL_ENABLE_PPR` and `RETRIEVAL_PPR_*` | false | PageRank over the entity graph; needs the GDS plugin |
| `RETRIEVAL_OVERFETCH_MULTIPLIER`, `RETRIEVAL_ASOF_OVERFETCH_MULTIPLIER` | 3, 4 | |
| `RETRIEVAL_ANN_MAX_K`, `RETRIEVAL_ANN_ESCALATION_GROWTH`, `RETRIEVAL_ANN_MAX_ATTEMPTS` | 2000, 4, 3 | adaptive K for selective filters |
| `RETRIEVAL_REFCOUNT_TICK_MODE` | `async` | `sync` or `off`; `off` stops recall from keeping facts alive |

## Retention, schedules, vault, state

| Variable | Default | Notes |
|---|---|---|
| `MEMORY_OBSERVATION_TTL_DAYS` | 7 | observations hard-deleted after this (hourly sweep) |
| `RESEARCH_RETENTION_DAYS` | unset | unset = research is never purged; set = grace days after `expiresAt` |
| `RESEARCH_REAP_CRON` | `15 * * * *` | only runs when retention is set |
| `KNOWLEDGE_EXTRACTION_CRON` | `*/2 * * * *` | attachment worker |
| `OKF_ENABLED`, `OKF_DIR`, `OKF_SYNC_CRON` | false, `./.okf-vault`, `30 3 * * *` | markdown vault |
| `ELEPHANT_STATE_DIR`, `ELEPHANT_SETTINGS_KEY` | `./.elephant-state`, unset | encrypted runtime settings |
| `KNOWLEDGE_*` | | attachments; see *Elephant: attachment OCR and transcription settings* |

Booleans accept `true`, `1`, `yes`, `on`; anything else (including `false`, `0`) is false.

`LLM_MAX_CONTEXT_TOKENS` is passed to whichever LLM adapter is selected and sets the context budget used for
summarising, extraction batching and rerank prompts (`/health` reports it as `llm.maxContextTokens`). Unset, each
adapter uses its own default: 200000 for Anthropic, 128000 for OpenAI, 8192 for llama.cpp.
