---
title: "Elephant: the dream cycle"
tags: [elephant, memory, dreaming, consolidation]
---

The dream cycle is Elephant's background consolidation job. It is the only place facts are extracted from
conversations, and it does the memory hygiene (supersede, merge, promote, prune). It uses the configured LLM
(`MEMORY_LLM_PROVIDER`) and the embedder; nothing on the request path waits for it.

## When it runs

- On a cron inside the service: `MEMORY_DREAM_CRON` (default `0 3 * * *`, nightly at 03:00; the stack sets it
  from `ELEPHANT_DREAM_CRON` in `stack.env`, so check `/home/cerebro/stack/elephant/.env` for the live value).
- On demand: `POST /dream` returns `{jobId}` immediately and runs the cycle in the background.
- Only one cycle runs at a time per service process. A second trigger while one runs gets
  **409 `dream already running as job <id>`**; a cron tick that lands during a run is skipped and logged as
  `[dream-cron] skipped tick, run <id> still in progress`. Both are harmless.

## What one cycle does

1. **Pick work.** Episodes not yet dreamed (`dreamedAt` null), with fewer than `DREAM_MAX_ATTEMPTS` (3) failed
   attempts and past their retry time, oldest by transaction time first, at most `DREAM_MAX_EPISODES_PER_RUN`
   (50). A soft deadline `DREAM_DEADLINE_MS` (300000 = 5 min) is checked between episodes.
2. **Install summaries.** Up to `DREAM_SUMMARY_SWEEP_MAX_EPISODES` (20) episodes whose summary is still the
   clipped placeholder from ingest get an LLM summary and a re-embedded vector.
3. **Per episode**, in chronological order:
   - extract facts and entities with the LLM, feeding the transcript in groups of at most ~2000 tokens; facts
     link to the chunks they came from (`:DERIVED_FROM`);
   - optionally extract entity-to-entity relations (`DREAM_ENABLE_RELATION_EXTRACTION`, min confidence 0.6);
   - **dedup**: skip a fact whose cosine to an existing live fact in the same scope bucket is above
     `DREAM_DEDUP_THRESHOLD` (0.92);
   - persist it with `validFrom = episode.timestamp`, `recordedAt = now`, the episode's scope;
   - **contradiction check**: search older facts with cosine at least `DREAM_SUPERSEDE_VECTOR_THRESHOLD` (0.85)
     in the same bucket and ask the LLM whether the new fact supersedes one; if so close the old one (see
     *Elephant: time, supersede and forgetting*). Facts from the same episode never supersede each other.
   - mark the episode dreamed. On an error the episode is stamped with an exponential backoff
     (`DREAM_RETRY_BACKOFF_BASE_MS` 60 s, doubling, capped at 6 h) and retried by later cycles; after the last
     attempt it is **dead-lettered** and no longer retried.
4. If the deadline has **not** been hit, the graph-wide passes run, each best-effort (a failure is logged and the
   cycle continues, because the facts are already committed):
   - **entity resolution**: re-embed touched entities by name and add `:SYNONYM` edges between near-identical
     names (`DREAM_ENTITY_SYNONYM_THRESHOLD` 0.9);
   - **supersede sweep**: facts written directly through `POST /facts` are contradiction-checked here, up to
     `DREAM_SUPERSEDE_SWEEP_MAX_FACTS` (50) per cycle, only once they are at least 60 s old;
   - **consolidation** (`DREAM_ENABLE_CONSOLIDATION`): for entities with at least 3 live facts in one scope
     bucket, cluster similar facts (similarity 0.8, clusters of up to 6, at most 10 clusters per run) and let the
     LLM merge complementary fragments into one canonical fact;
   - **insight promotion**: facts created this cycle with importance at least `DREAM_PROMOTE_INSIGHT_IMPORTANCE`
     (0.85) become insights, unless a near-identical insight exists (then it is corroborated instead);
   - **prune** along the forgetting curve, then retire insights whose source facts are all dead.
5. If `RETRIEVAL_ENABLE_PPR=true`, refresh the GDS graph projection used by PageRank recall (runs even when the
   deadline was hit).

The dreamer extracts **facts only**. Preferences and intentions are never created by dreaming; callers write them.

Each cycle is recorded as a `:DreamRun` with `status` (`running`, `completed`, `failed`), `episodesProcessed`,
`factsCreated`, `factsSuperseded`, `factsPruned`, `factsMerged`, `insightsPromoted` and `error`. Every change it
makes is audited with `actor: "dreamer"`.

## Triggering and monitoring

```bash
TOKEN=$(sed -n 's/^MEMORY_SERVICE_TOKEN=//p' /home/cerebro/stack/elephant/.env)
E=http://127.0.0.1:18790
curl -s $E/health | jq .data.dream          # lastRun, running, runningJobId, backlogEstimate, deadLetteredEpisodes
curl -s -X POST -H "Authorization: Bearer $TOKEN" $E/dream | jq          # -> {"jobId": "..."} or 409
curl -s -H "Authorization: Bearer $TOKEN" $E/dream/<jobId> | jq          # poll until status is completed/failed
curl -s -H "Authorization: Bearer $TOKEN" "$E/dashboard/api/dreams?limit=10" | jq   # recent runs
bin/stack logs elephant          # from /home/cerebro/cerebro-stack; look for "[dream" lines
```

Reading `/health.data.dream`:

- `backlogEstimate`: episodes still owed a dream attempt. Each cycle takes at most 50, so a large import drains
  over several cycles; trigger `POST /dream` repeatedly (waiting for each to finish) to drain faster.
- `deadLetteredEpisodes`: episodes that failed every attempt and will not be retried. Non-zero means those
  conversations produced no facts. Fix the cause (usually the LLM endpoint) first.
- `running` / `runningJobId`: an in-progress cycle in this process. `lastRunDurationMs` is the last run's length.

Prefer `POST /dream` over `pnpm dream`: the CLI (`scripts/dream.ts`) runs a cycle in a separate process whose
lock does not see the service's, so it can overlap a scheduled run.

## Re-queuing dead-lettered episodes

There is no API for this. After fixing the cause and taking a backup, reset their counters in Neo4j; the next
cycle picks them up:

```bash
cd /home/cerebro/stack/elephant
PW=$(sed -n 's/^NEO4J_PASSWORD=//p' .env)
docker exec elephant-neo4j cypher-shell -u neo4j -p "$PW" \
  "MATCH (e:Episode) WHERE e.dreamedAt IS NULL AND coalesce(e.dreamAttempts,0) >= 3
   SET e.dreamAttempts = 0, e.dreamNextAttemptAt = NULL RETURN count(e)"
```

(Use your `DREAM_MAX_ATTEMPTS` in place of 3 if you changed it.)

## Rebuilding all facts

`pnpm rebuild:facts -- --yes` (from `/home/cerebro/stack/elephant`) deletes every fact and insight and marks all
episodes undreamed, so the current pipeline re-extracts everything from the retained episodes. Episodes,
chunks, entities, documents and audit events are kept. Back up first, then trigger dreams until
`backlogEstimate` reaches 0. On a large graph this means many LLM calls.

## Notes

- A cycle killed with its process leaves its run row at `running`; at the next boot rows older than
  max(4 x `DREAM_DEADLINE_MS`, 1 hour) are marked failed.
- Long cycles hold the LLM (and, on a local deployment, the GPU) for minutes. Schedule the cron when the
  assistant is quiet, or lower `DREAM_MAX_EPISODES_PER_RUN` / `DREAM_DEADLINE_MS`.
- Older docs mention a persistent "dream cursor"; the current code selects work by per-episode markers
  (`dreamedAt`, `dreamAttempts`, `dreamNextAttemptAt`) instead.
