# Elephant Memory Provider

External memory provider for [hermes-agent](https://github.com/NousResearch/hermes-agent)
backed by the [elephant](https://github.com/kainappsinc/elephant) memory
service: hybrid GraphRAG recall, bi-temporal facts, versioned preferences, and
nightly consolidation ("dreaming") on Neo4j. Stdlib-only — no pip dependencies.

## What it does

- **Tools** — `memory_recall`, `memory_save`, `memory_forget`,
  `memory_timeline`, `memory_entity`, `memory_preference_get`,
  `memory_preference_set`, `memory_observe`
- **Prefetch** — query-conditioned recall injected before each turn
  (`prefetch` / `queue_prefetch` with a warm cache)
- **Turn sync** — every completed turn is queued to a daemon worker and
  flushed to elephant as an Episode (non-blocking; elephant's nightly dreamer
  extracts facts server-side)
- **Pre-compression snapshots** — the about-to-be-compressed span is saved as
  an Episode so nothing is lost to compaction
- **Built-in mirror** — hermes's own memory writes are mirrored into the graph
  via `on_memory_write`

Hermes's built-in memory stays active alongside, per the provider contract.

## Requirements

A running elephant service. From the elephant repo:

```bash
docker compose up -d neo4j && pnpm migrate && pnpm serve
```

## Setup

1. Copy or symlink this directory into `plugins/memory/elephant/` of your
   hermes checkout (or `$HERMES_HOME/plugins/memory/elephant/`).
2. Run `hermes memory setup` and select **elephant**. The wizard asks for:
   - `token` (secret → `.env` as `ELEPHANT_SERVICE_TOKEN`)
   - `url` (default `http://127.0.0.1:18790`)
   - `agent_id` (default `hermes`), optional `project_id` / `user_id`
   - `auto_recall_limit` (default 8)

Non-secret settings land in `$HERMES_HOME/elephant.json`.

## CLI

With the provider active: `hermes elephant status | recall <q> | save <fact> |
forget <id> | prefs | dream`.

## Development

Tests live one level up (`adapters/hermes/tests/` in the elephant repo) and
run without a hermes checkout or a live service:

```bash
uv run --with pytest pytest -q
```
