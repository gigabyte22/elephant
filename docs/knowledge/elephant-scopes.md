---
title: "Elephant: memory scopes"
tags: [elephant, memory, scopes, isolation]
---

Elephant has one bearer token and no user accounts. What keeps one user's or one project's memory apart from
another's is **scope**: up to four optional string fields stored on memory items, and a per-axis **mode** that
each read chooses. Callers (Cerebro) decide the values; Elephant applies them consistently.

## The four axes

| Axis | Stored on | Typical meaning |
|---|---|---|
| `projectId` | every memory item | the project a memory belongs to |
| `userId` | every memory item | the person it is about / belongs to |
| `agentId` | episodes, observations, intentions; facts by **origin** | which agent produced it |
| `sessionId` | episodes, observations, intentions; facts by **origin** | which conversation produced it |

**Null means shared.** An item with no value on an axis is a shared/global item on that axis, not an orphan. A
fact's agent/session is judged by its origin: the source episode's `agentId`/`sessionId`, falling back to the
fact's own fields on direct `POST /facts` writes. Categories with no agent/session field (preferences, insights,
procedures, knowledge, research, chunks) count as null on those axes.

## The five modes

| Mode | Effect on an axis |
|---|---|
| `boost` | everything still matches; items with the caller's value rank higher |
| `filter` | excludes items with a **different** value; items with the same value **and null (shared) items** match |
| `strict` | like `filter`, but also excludes null items: only the caller's own value |
| `shared` | only null (shared) items; the one mode that needs no axis value |
| `none` | the axis is ignored |

A `filter` or `strict` mode without a value on that axis collapses to `none`. Omitting an axis is therefore *not*
the same as asking for shared items: it spans every scope.

## Defaults per surface

- **`GET /recall`**: per axis, `boost` when you pass a value, `none` when you don't. Override with
  `projectScope`, `userScope`, `agentScope`, `sessionScope`. Boost multipliers: project x1.2, user x1.1 (fixed),
  own agent x`RETRIEVAL_OWN_AGENT_BOOST` (1.15), same session x`RETRIEVAL_SAME_SESSION_BOOST` (1.05).
- **List routes** (`GET /knowledge/documents`, `/procedures`, `/research`, `/intentions`, `/intentions/due`):
  `filter` when you pass the id, `none` when you don't; explicit `projectScope`/`userScope` (and on intentions
  `agentScope`/`sessionScope`) override. `GET /research` requires `projectId` unless an explicit `projectScope` is
  sent. `projectScope=shared` on research is always empty (research always has a project); `userScope=shared`
  is the meaningful shared listing there.
- **Id-addressed reads and writes** (`GET/PUT/DELETE /facts/:id`, `/knowledge/documents/:id`, `/procedures/:id`,
  `/research/:id`, `GET /intentions/:id`, attachment routes): optional `?projectId=&userId=` query guard with
  `filter` semantics. An item in a different scope answers **404, not 403** (existence is itself scoped); a
  shared (null) item stays reachable; a caller that declares no scope is unrestricted. Supersede checks both facts.
- `GET /observations?sessionId=` is per session; `&userId=` separates one participant in a shared session
  (null-user rows still match).
- `GET /preferences` and `/preferences/:key` take `?projectId=&userId=`.

## Writes

Where the scope goes on a write differs by route:

| Route | Scope fields |
|---|---|
| `POST /episodes`, `POST /facts`, `POST /observations` | top-level `projectId`, `userId` (+ `agentId`, `sessionId`) |
| `POST /knowledge/documents`, `POST /procedures` | nested `scope: {projectId, userId}` |
| `POST /research` | top-level `projectId` (**required**) and `userId`; both immutable afterwards |
| `POST /intentions` | nested `scope: {projectId, userId, agentId, sessionId}` |
| `POST /state` | `scope: {agentId (required), sessionId, userId, projectId}`; working state is keyed by scope, not filtered |

## Scope inside the dream cycle

- Facts extracted from an episode inherit the episode's `projectId`; `userId` is the episode's, or the declared
  participant the fact is about (multi-party episodes), or null for world/group facts.
- Dedup, contradiction supersede and consolidation work inside one bucket of (`projectId`, `userId`). With
  `DREAM_CROSS_SCOPE_DEDUP=true` (default) a scoped episode also skips facts the **unscoped** bucket already holds
  (read-only, never another project's bucket); episodes posted with `isolated: true` opt out.
- `DREAM_CROSS_SCOPE_SUPERSEDE=false` (default) keeps supersede from closing an unscoped fact because of a
  scoped episode, which would move shared knowledge into one account's private scope. Single-tenant installs may
  turn it on.
- Insights carry their source fact's scope.

## Practical consequences

- To see "only this user's memories plus shared ones": pass `userId=<id>&userScope=filter`.
- To see "only this user's, nothing shared": `userScope=strict`.
- To list shared/global items only: `userScope=shared` (no `userId` needed).
- Retired legacy user ids (values no caller will ever send again) strand their rows in their own bucket;
  `scripts/backfill-retire-legacy-user-ids.ts --retire=a,b --dry-run` lists every user value with counts and can
  clear them into the shared lane (`--yes`, reversible with `--undo --yes`). Back up first.
- How Cerebro derives these values from a session is Cerebro's concern; see *Cerebro: memory scopes*.
