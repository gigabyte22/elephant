---
title: "Elephant: time, supersede and forgetting"
tags: [elephant, memory, bitemporal, forgetting]
---

Elephant keeps two clocks on facts and treats "forgetting" as closing an interval, not deleting a node. This
note explains what each date means, how a fact stops being current, and the few places where data really is
deleted.

## Two clocks (bi-temporal facts)

| Clock | Fields | Meaning |
|---|---|---|
| Valid time | `validFrom`, `validTo` | when the claim held in the world or conversation. `validTo = null` means still valid. |
| Transaction time | `recordedAt`; `supersededAt` on the `:SUPERSEDES` edge | when Elephant wrote or decided it |

Write rules:

- A fact the dream cycle extracts from an episode gets `validFrom = episode.timestamp` (event time) and
  `recordedAt = now`.
- `POST /facts` takes an optional `validFrom`; if omitted and `sourceEpisodeId` is given, the episode's timestamp
  is used; otherwise now.
- Preferences: `PUT /preferences/:key` writes a new version and closes the previous one
  (`prior.validTo = new.validFrom`); preferences carry `recordedAt` too.
- Intentions get `validTo` set when they reach a terminal status (completed, cancelled, expired).

Decay, prune and the recency part of recall scoring use **transaction/access time** (`recordedAt`,
`lastReferencedAt`), never the event time. That is why importing old conversations with historical timestamps
does not make their facts instantly "old" and prunable.

`GET /timeline?at=<iso>` is a valid-time snapshot: every fact whose interval covers `at` (and, with `preferenceKey=`, that preference's value at that instant).
`GET /recall?asOf=<iso>` applies the same valid-time filter inside ranked recall (default: now, unless
`includeSuperseded=true`).

## How a fact stops being current

| Event | Trigger | What changes | Still visible to `/timeline` and `asOf`? |
|---|---|---|---|
| **Supersede** (contradiction) | dream cycle judges a newer fact contradicts an older one, or a caller calls `POST /facts/:id/supersede {newFactId, reason}` | old fact `validTo = max(old.validFrom, new.validFrom)` (event time); `(new)-[:SUPERSEDES {reason, supersededAt: now}]->(old)` | yes, for instants inside its old interval |
| **Consolidation merge** | dream cycle merges 2+ fragment facts about one entity into one canonical fact | members closed at transaction time; the survivor's `validFrom` is the earliest member's | members are collapsed when the survivor covers the instant |
| **Prune** | dream cycle, forgetting curve (below) | `validTo = now`, `prunedAt = now`; audit event `prune` | yes (a prune is a system forget, not a change in the world) |
| **Redaction** | `DELETE /facts/:id` | `deletedAt = now`; `validTo` closed only if still open | **no**: invisible at every instant, including `includeSuperseded` and any `asOf`; `GET /facts/:id` returns 404 |

A redacted fact id cannot be re-created by posting the same id again (409). Superseded facts still return from
`GET /facts/:id`.

Insights are retired automatically when the facts they were promoted from are all dead (superseded, merged,
pruned or redacted); a nightly reconciliation pass in the dream cycle catches any the write-time cascade missed.

## The forgetting curve (prune rule)

For each live fact the dream cycle computes an Ebbinghaus retention:

```
strength  = (1 + 2 * referenceCount) * (1 + 4 * importance)
retention = exp(-daysSinceLastReference / strength)
```

A fact is pruned only when all of these hold:

1. `importance` < `DREAM_PRUNE_IMPORTANCE_EXEMPT` (default 0.75). Facts at or above that are never auto-pruned.
2. It has not been referenced for at least `DREAM_PRUNE_WINDOW_DAYS` (default 30).
3. `retention` < `DREAM_PRUNE_RETENTION_FLOOR` (default 0.05).

At most `DREAM_PRUNE_BATCH_LIMIT` (1000) facts are pruned per cycle. **Recall keeps memories alive:** every
recall that returns a fact increments its `referenceCount` and updates `lastReferencedAt` (asynchronously by
default; `RETRIEVAL_REFCOUNT_TICK_MODE=async|sync|off`). Examples from the code's own notes: importance 0.5 with no
references is pruned shortly after the 30-day window; importance 0.6 with 3 references survives about 71
unreferenced days. The dashboard's *Memory health* page plots retention against the prune floor so you can see
what is about to be forgotten.

## Soft delete for other categories

`DELETE /procedures/:id`, `DELETE /research/:id` and `DELETE /knowledge/documents/:id` soft-delete (close the
item and record an audit event); list and recall stop returning it. Knowledge documents, research and
procedures also take an optional `expiresAt`: once it has passed, their content stops surfacing in recall, but
the item can still be fetched by id, and raising `expiresAt` (a `PUT`) brings it back. Lapsed research is only
ever purged when research retention is enabled (below).

## Where data really is deleted

These are the only hard deletes:

| What | When | Notes |
|---|---|---|
| Observations | hourly, once older than `MEMORY_OBSERVATION_TTL_DAYS` (default 7) | short-lived by design |
| Research past its grace period | only if `RESEARCH_RETENTION_DAYS` is set; the reaper (`RESEARCH_REAP_CRON`, default `15 * * * *`) purges research whose `expiresAt` lapsed that many days ago, with its chunks and revision snapshots; audit events stay | unset by default, so nothing is purged |
| Knowledge document chunks and attachment blobs | `DELETE /knowledge/documents/:id?purge=true` | without `purge` it is a soft delete |
| One attachment | `DELETE /knowledge/documents/:id/attachments/:attachmentId` | removes its chunks, node and blob file |
| Vault tombstones | `pnpm okf:sync --purge` | files only; the graph is untouched |
| Operator scripts | `scripts/wipe.ts --yes` (everything), `pnpm rebuild:facts -- --yes` (all facts and insights, then re-dream) | back up first; not reversible |
