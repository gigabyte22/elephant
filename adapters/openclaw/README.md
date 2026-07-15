# openclaw-memory-elephant

OpenClaw memory plugin backed by the [elephant](https://github.com/kainappsinc/elephant)
memory service: hybrid GraphRAG recall, bi-temporal facts, versioned
preferences, and nightly consolidation ("dreaming") on Neo4j.

Replaces the default memory slot with:

- **Eight tools** — `memory_recall`, `memory_save`, `memory_forget`,
  `memory_timeline`, `memory_entity`, `memory_preference_get`,
  `memory_preference_set`, `memory_observe`
- **Auto-recall** (`before_agent_start`) — query-conditioned recall prepended
  to the agent context as `<relevant-memories>`; failures never block the agent
- **Auto-capture** (`agent_end`) — the finished turn is flushed to elephant as
  an Episode; fact extraction happens server-side in elephant's nightly dreamer
- **CLI** — `openclaw elephant status | recall | save | forget | prefs | dream`

## Requirements

A running elephant service (Neo4j + the elephant HTTP server). See the
elephant README for the quickstart; by default it listens on
`http://127.0.0.1:18790`.

## Install

From a local checkout (npm/ClawHub publish TBD):

```bash
openclaw plugin install /path/to/elephant/adapters/openclaw
```

Then select the memory slot in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    slots: { memory: "memory-elephant" },
    entries: {
      "memory-elephant": {
        enabled: true,
        config: {
          url: "http://127.0.0.1:18790",
          token: "<MEMORY_SERVICE_TOKEN>",
          agentId: "openclaw",
          userId: "you",
          autoRecall: { enabled: true, limit: 8 },
          autoCapture: { enabled: true }
        }
      }
    }
  }
}
```

Only one `kind: "memory"` plugin can be active; selecting this one replaces
`memory-core`.

## Development

This directory lives in the elephant monorepo but installs standalone — the
HTTP client under `vendor/` is a generated copy of `packages/client/src`
(regenerate with `pnpm sync:vendored-client`; a test fails on drift).

```bash
pnpm --filter openclaw-memory-elephant test
```

Note: the `before_agent_start` / `agent_end` event payload shapes follow the
de-facto memory-plugin template (memory-mem0) and are accessed defensively;
if your OpenClaw version passes different fields, session ids fall back to
`<agentId>:default`.
