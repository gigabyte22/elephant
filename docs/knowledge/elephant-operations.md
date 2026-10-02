---
title: "Elephant: operations (start, stop, logs, upgrade, migrations, dashboard)"
tags: [elephant, operations, systemd, migrations]
---

How to run and look after Elephant on this host. Operations run as the `cerebro` user; `bin/stack` is run from
`/home/cerebro/cerebro-stack`; Elephant's deployed checkout is `/home/cerebro/stack/elephant`.

## Units

| Unit | What it does |
|---|---|
| `elephant-neo4j.service` | oneshot: `docker compose up -d --force-recreate neo4j` in the checkout, then waits up to 120 s for Bolt (127.0.0.1:7687). Stop: `docker compose stop neo4j`. Data lives in docker volumes (`neo4j-data` etc., prefixed by the compose project) and survives the recreate. |
| `elephant.service` | `ExecStartPre`: `tsx scripts/migrate.ts`; `ExecStart`: `tsx scripts/serve.ts`. `Requires=elephant-neo4j.service`. `Restart=always`, `RestartSec=5`. |
| `elephant-backup.timer` | optional (`ELEPHANT_BACKUP_TIMER=1` in `stack.env`), daily 02:30 graph dump into `$BACKUP_DIR/neo4j-daily`. The default `stack-backup.timer` already dumps the graph daily. |

Neo4j runs with 1 GB page cache and a 1-2 GB heap (compose file), with the APOC and Graph Data Science plugins.

## Start, stop, status, logs

```bash
cd /home/cerebro/cerebro-stack
bin/stack status                    # unit states + health of each service
bin/stack up neo4j elephant         # start in order, waits for health (elephant: up to 300 s)
bin/stack down elephant             # stop the service (neo4j keeps running)
bin/stack down elephant neo4j       # stop both
STACK_UP_RESTART=1 bin/stack up elephant   # restart elephant (picks up .env changes)
bin/stack logs elephant             # journalctl -f for elephant.service; --no-follow for a snapshot
bin/stack logs neo4j
bin/stack doctor                    # includes "elephant .../health (embedModel ...)"
```

`bin/stack up/down` use sudo for systemctl. Directly: `sudo systemctl restart elephant.service`,
`journalctl -u elephant.service -n 200 --no-pager`. Neo4j's own log: `docker logs elephant-neo4j`.

Healthy looks like: `curl -s http://127.0.0.1:18790/health | jq .data` shows `neo4j: true`,
`embedder.dim == schemaVectorDim`, `embedModel == schemaEmbedModel`, a recent `dream.lastRun`, and
`deadLetteredEpisodes` / `extraction.deadLettered` at 0. At boot the log prints
`elephant listening on http://127.0.0.1:18790 (llm=..., embedder=..., dim=..., dreamCron=..., extractionCron=...)`
and one `[extraction]` line per attachment capability.

On SIGTERM the service stops its schedulers and closes cleanly. A dream cycle cut off by a restart leaves its run
marked `running` until the next boot reaps it (after max(4 x `DREAM_DEADLINE_MS`, 1 h)).

## Background jobs inside the service

| Job | Schedule | Notes |
|---|---|---|
| Dream cycle | `MEMORY_DREAM_CRON` (default `0 3 * * *`) | see *Elephant: the dream cycle* |
| Observation reaper | hourly (`0 * * * *`, fixed) | deletes expired observations |
| Attachment extraction worker | `KNOWLEDGE_EXTRACTION_CRON` (`*/2 * * * *`) | one pending attachment per tick |
| OKF vault sync | `OKF_SYNC_CRON` (`30 3 * * *`) | only with `OKF_ENABLED=true` |
| Research reaper | `RESEARCH_REAP_CRON` (`15 * * * *`) | only with `RESEARCH_RETENTION_DAYS` set |

## Upgrades and migrations

`bin/stack upgrade` (optionally `--bump`) backs up, moves the checkout to the locked ref, runs
`pnpm install --frozen-lockfile`, re-renders `.env`, restarts in order and runs doctor. Elephant migrates itself:
`scripts/migrate.ts` runs before **every** start. It is idempotent:

1. Creates constraints, range/full-text indexes and one vector index per embedded label (`IF NOT EXISTS`, sized
   to `EMBED_DIM`), then waits up to 60 s for indexes to come online.
2. Applies each data migration whose id has no `(:SchemaMigration {id})` node yet, and records it. Current list:
   `0001-memory-item-labels`, `0002-entity-name-norm`, `0003-episode-dream-markers`,
   `0004-procedure-lineage-dedup`, `0005-fact-lifecycle`.
3. Records the embedding model and dimension on `(:SystemState {key:'embedding'})` the first time; afterwards it
   only warns (`[migrate] WARNING: The configured embedder does not match ...`) and the service then refuses to
   start (see *Elephant: changing the embedding model*).

To run it by hand: `cd /home/cerebro/stack/elephant && pnpm migrate`.

## Maintenance scripts

Run from `/home/cerebro/stack/elephant` (they read the same `.env`). All of them change the live graph: **take a
backup first** (*Elephant: backup and restore*).

| Command | What it does |
|---|---|
| `pnpm reembed --dry-run` / `--yes` | re-embed every vector after an embedding-model change |
| `pnpm backfill:attachment-extraction [--yes]` | re-run OCR/transcription/text extraction on attachments |
| `pnpm okf:sync [--dry-run] [--purge]` | reconcile the markdown vault |
| `pnpm rebuild:facts -- --yes` | delete all facts and insights, mark episodes undreamed, then re-dream |
| `pnpm backfill:bitemporal -- --dry-run` / `--yes` | repair `validFrom`/`validTo`/`recordedAt` on old graphs |
| `pnpm backfill:fact-supersede-checked [--cutoff=<iso>] [--yes]` | one-off after upgrading past the deferred contradiction check: stamps facts recorded before `--cutoff` as already checked, so the dream sweep does not re-judge the whole back catalogue (dry run without `--yes`) |
| `pnpm backfill:retire-legacy-user-ids --retire=a,b --dry-run` | clear dead user-axis values into the shared lane (`--undo` reverses) |
| `pnpm wipe --yes` | **deletes all data** (schema kept). Never needed in normal operation |

**Never run `pnpm test`, `pnpm test:integration`, `vitest`, or `bun test` in the deployed checkout.** The
integration specs delete everything in the database they connect to, and without their dedicated config they
connect to whatever `.env` says, which is the live graph (this destroyed a production graph once).

## The dashboard

A read-only inspector served by the service at `http://127.0.0.1:18790/dashboard/` (sign in by pasting the
`MEMORY_SERVICE_TOKEN`; the browser keeps it in localStorage). Pages: Overview (counts, kind breakdown, episode
origins, top facts), Graph explorer, Facts, Entities, Documents (knowledge and research, rendered as markdown),
Timeline, Dreams (run history and counters), Memory health (retention distribution against the prune floor,
retention vs idle days per fact) and Audit. A scope bar filters by project/user.

The stack does not build the dashboard. Until it is built, `/dashboard` answers 503 "dashboard build not found".
To build it (the API keeps working either way):

```bash
cd /home/cerebro/stack/elephant && pnpm --filter @elephant/web build
```

The build output (`web/dist`) is ignored by git and survives upgrades, but reflects the version it was built
from; rebuild after an upgrade to get dashboard changes. The service binds to 127.0.0.1, so open it from this host
or through an SSH tunnel.

## Neo4j directly

Neo4j Browser is on `http://127.0.0.1:7474` (user `neo4j`, password `NEO4J_PASSWORD` from Elephant's `.env`).
For a one-off query: `docker exec elephant-neo4j cypher-shell -u neo4j -p "$PW" "<cypher>"`. Treat writes there
as surgery: back up first, and prefer the API.
