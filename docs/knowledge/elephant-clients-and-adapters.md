---
title: "Elephant: client package and adapters"
tags: [elephant, client, adapters, mcp]
---

Elephant has no SDK lock-in: everything is the HTTP API (see *Elephant: HTTP API reference*). The repo ships a
typed TypeScript client and three ready-made adapters that are thin wrappers over it. Cerebro does not use the
adapters; it carries its own vendored copy of the client and its own memory adapter.

## `@kainappsinc/elephant-client` (packages/client)

A typed HTTP client, published to npm, ESM, Node >= 22, no runtime dependencies. One method per route, bearer
auth, unwraps the `{ok, data}` envelope (throws on `{ok:false}`), retries 5xx and network errors with exponential
backoff (default 3 retries), 30 s default timeout, per-call `AbortSignal`/`timeoutMs`/`retries` overrides, and an
optional `defaultProjectId` applied to writes that take a project and did not set one.

```ts
import { ElephantClient } from '@kainappsinc/elephant-client';
const elephant = new ElephantClient({ url: 'http://127.0.0.1:18790', token: process.env.MEMORY_SERVICE_TOKEN! });
await elephant.health();
await elephant.saveFact({ content: 'the deploy dashboard lives behind the vpn', agentId: 'assistant', actor: 'assistant' });
const { facts } = await elephant.recall({ q: 'deploy dashboard', agentId: 'assistant' });
```

The wire types are duplicated from the service on purpose: consumers never import service source. Compatibility
is checked at runtime through `GET /health` (embedder dimension, schema vector dimension, capability flags such as
`episodeMetadata`, `researchMetadata`, `researchSimilar` that a client feature-detects before sending optional
fields). When the wire shapes change, the client must be updated in the same change. Releases: bump the version,
tag `client-v<version>`; CI publishes with `pnpm publish`.

Cerebro keeps a vendored copy of this client in its own source tree (`src/vendor/elephant-client`), so a new
Elephant field reaches Cerebro only when that copy is refreshed.

## MCP server (adapters/mcp)

An MCP stdio server for MCP hosts such as Claude Code or Claude Desktop. Tools: `memory_save`, `memory_recall`,
`memory_forget` (by id; a fuzzy query never bulk-deletes), `memory_timeline`, `memory_entity`,
`memory_preference_get` / `_set`, `memory_observe`, `memory_knowledge_*`, `memory_research_*` (needs
`ELEPHANT_PROJECT_ID`), `memory_procedure_*`, `memory_intention_*`, `memory_state_*`, `memory_audit`. Dreaming is
deliberately not a tool.

Config by env: `MEMORY_SERVICE_URL` (default `http://127.0.0.1:18790`), `MEMORY_SERVICE_TOKEN` (required),
`ELEPHANT_AGENT_ID` (default `mcp`), `ELEPHANT_SESSION_ID` (generated per process), `ELEPHANT_PROJECT_ID`,
`ELEPHANT_USER_ID`, and per-axis recall modes `ELEPHANT_AGENT_SCOPE`, `ELEPHANT_SESSION_SCOPE` (default `boost`),
`ELEPHANT_PROJECT_SCOPE`, `ELEPHANT_USER_SCOPE` (default `none`). It runs from the checkout with `tsx`
(`npx -y tsx <elephant>/adapters/mcp/src/index.ts`); not published to npm. It starts even when Elephant is down;
tools then fail per call.

## OpenClaw plugin (adapters/openclaw)

Replaces OpenClaw's memory slot (`memory-elephant`): the eight core `memory_*` tools, auto-recall before each
agent turn (prepended as `<relevant-memories>`), auto-capture of each finished turn as an episode, and an
`openclaw elephant status|recall|save|forget|prefs|dream` CLI. Installed from a local checkout
(`openclaw plugin install <elephant>/adapters/openclaw`). It carries a generated copy of the client under
`vendor/` (regenerated with `pnpm sync:vendored-client`).

## hermes-agent provider (adapters/hermes)

A Python, stdlib-only memory provider for hermes-agent: the `memory_*` tools including knowledge, research,
procedures, intentions and working state; query-conditioned prefetch before each turn; non-blocking episode
writes per turn; pre-compression snapshots; capture of subagent results; a `hermes elephant` CLI. Install with
`pip install ./adapters/hermes && hermes-elephant install`.

## Conventions every caller should follow

- Send a stable `agentId` and `sessionId` on episodes and observations, and `projectId`/`userId` wherever the
  memory belongs to a project or a person; pick recall scope modes deliberately (*Elephant: memory scopes*).
- Choose the right write tier: durable one-line beliefs -> `POST /facts`; whole conversations -> `POST /episodes`
  (facts are extracted later); scratch notes for the next turns -> observations; reference material -> knowledge
  documents; generated pipeline output -> research; reusable how-tos -> procedures; reminders -> intentions;
  machine state (cursors, ids) -> `/state`, never prose.
- Pass `timestamp` on episodes when importing history, and an `actor` on writes so the audit trail says who did it.
- Set `includeKnowledge`, `includeResearch`, `includeIntentions` (and `includeProcedures`) on recall when those
  categories should be reachable; they are off server-side by default.
- Feature-detect optional fields through `/health` before sending them to an older server.
