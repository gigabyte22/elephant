# @elephant/mcp

MCP server exposing the elephant memory service to any MCP host (Claude Code,
Claude Desktop, …). Tools over elephant's HTTP API:

| Tool | Purpose |
|---|---|
| `memory_save` | persist a durable fact (with origin scope + audit actor) |
| `memory_recall` | semantic recall across every category |
| `memory_forget` | soft-delete by id; fuzzy query never bulk-deletes |
| `memory_timeline` | bi-temporal "what was believed at time T" |
| `memory_entity` | entity search / entity + fact subgraph |
| `memory_preference_get` / `memory_preference_set` | versioned user preferences |
| `memory_observe` | short-lived session-scoped working memory |
| `memory_knowledge_*` | save/get/list/update/delete reference documents |
| `memory_research_*` | save/get/list/update/delete project research (needs `ELEPHANT_PROJECT_ID`) |
| `memory_procedure_*` | save/get/list/update/delete reusable how-tos |
| `memory_intention_*` | create/list/due/complete/cancel/fired prospective memory |
| `memory_state_*` | set/get/list/delete agent working state |
| `memory_audit` | revisions + audit events for one memory item |

`/dream` (consolidation) is deliberately not a tool — it runs on elephant's
own schedule.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `MEMORY_SERVICE_URL` | `http://127.0.0.1:18790` | where elephant listens |
| `MEMORY_SERVICE_TOKEN` | — (required) | elephant's bearer token, min 8 chars |
| `ELEPHANT_AGENT_ID` | `mcp` | identifies this host, e.g. `claude-code` |
| `ELEPHANT_SESSION_ID` | generated per process | stable id groups observations |
| `ELEPHANT_PROJECT_ID` / `ELEPHANT_USER_ID` | unset | optional scope axes |
| `ELEPHANT_*_SCOPE` | `boost` (agent/session), `none` (project/user) | recall mode per axis |

## Install (Claude Code)

`.mcp.json` in your project (or `claude mcp add`):

```json
{
  "mcpServers": {
    "elephant": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/elephant/adapters/mcp/src/index.ts"],
      "env": {
        "MEMORY_SERVICE_URL": "http://127.0.0.1:18790",
        "MEMORY_SERVICE_TOKEN": "<token>",
        "ELEPHANT_AGENT_ID": "claude-code"
      }
    }
  }
}
```

## Development

```bash
pnpm --filter @elephant/mcp test        # vitest, no elephant needed
pnpm --filter @elephant/mcp dev         # stdio server via tsx
npx @modelcontextprotocol/inspector npx tsx src/index.ts   # interactive smoke test
```

The server starts even when elephant is unreachable (the probe logs to
stderr); tools fail per-call with the underlying error until the service is
up. npm publishing is deferred — run from the repo via `tsx` for now.
