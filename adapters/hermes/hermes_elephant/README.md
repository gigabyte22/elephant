# Elephant Memory Provider for Hermes

External memory provider for [hermes-agent](https://github.com/NousResearch/hermes-agent)
backed by the [elephant](https://github.com/kainappsinc/elephant) memory
service: hybrid GraphRAG recall, bi-temporal facts (valid time vs transaction
time), versioned preferences, and nightly consolidation ("dreaming") on Neo4j.

Stdlib-only — installing it adds no package to the hermes runtime.

## What it does

- **Tools** — `memory_recall`, `memory_save`, `memory_forget`,
  `memory_timeline`, `memory_entity`, `memory_preference_get`,
  `memory_preference_set`, `memory_observe`, plus the knowledge, research,
  procedure, intention, and working-state surfaces.
- **Prefetch** — query-conditioned recall injected before each turn
  (`prefetch` / `queue_prefetch` with a warm cache).
- **Turn sync** — every completed turn is queued to a daemon worker and flushed
  as an Episode (non-blocking; elephant's nightly dreamer extracts facts
  server-side).
- **Pre-compression snapshots** — the span about to be compacted is saved as an
  Episode, so nothing is lost to compression.
- **Delegation capture** — when a subagent finishes, its task and result land on
  the parent's session. Subagents run with `skip_memory=True` and have no
  provider session of their own, so without this a turn whose real work happened
  inside a subagent would be recorded as an assistant message with nothing
  behind it.
- **Built-in mirror** — hermes's own memory writes are mirrored into the graph
  via `on_memory_write`.

Hermes's built-in memory (MEMORY.md / USER.md) stays active alongside, per the
provider contract.

## Requirements

A running elephant service. From the elephant repo:

```bash
docker compose up -d neo4j && pnpm migrate && pnpm serve
```

## Install

```bash
pip install hermes-elephant     # into the hermes venv
hermes-elephant install
hermes memory setup             # select 'elephant'
```

### Why the second step

Hermes discovers memory providers by scanning directories — the bundled
`plugins/memory/` tree and `$HERMES_HOME/plugins/` — and does **not** scan pip
entry points (upstream [#40101](https://github.com/NousResearch/hermes-agent/issues/40101);
PRs [#18842](https://github.com/NousResearch/hermes-agent/pull/18842),
[#40644](https://github.com/NousResearch/hermes-agent/pull/40644) and
[#76567](https://github.com/NousResearch/hermes-agent/pull/76567) are open
against it). So `pip install` alone leaves the provider invisible and
`hermes memory status` reports `Plugin: NOT installed`.

`hermes-elephant install` copies the provider into
`$HERMES_HOME/plugins/elephant/`, the path stock hermes already supports. This
package also declares a `hermes_agent.memory_providers` entry point, so once
entry-point discovery lands upstream the install step becomes redundant.

```bash
hermes-elephant status                                # where it goes, and whether it's there
hermes-elephant install --link                        # symlink instead of copy (development)
hermes-elephant uninstall
HERMES_HOME=~/.hermes-work hermes-elephant install    # a specific profile
```

Re-run `hermes-elephant install` after `pip install -U hermes-elephant`: the
upgrade replaces the package, but the copy already sitting in
`$HERMES_HOME/plugins/elephant/` keeps running the old version until you do.
(`hermes update` does *not* require this — it rebuilds the install directory
and leaves `$HERMES_HOME` alone.)

## Configuration

`hermes memory setup` prompts for the token (written to `.env` as
`ELEPHANT_SERVICE_TOKEN`) plus the service URL, agent id, optional
`project_id` / `user_id`, and `auto_recall_limit`. Non-secret settings land in
`$HERMES_HOME/elephant.json`. The same fields are editable from the hermes
dashboard, which renders them from `config_schema.py`.

`ELEPHANT_URL` overrides the configured URL when set.

## CLI

With the provider active:

```bash
hermes elephant status
hermes elephant recall <query> [--limit N]
hermes elephant save <fact> [--category C]
hermes elephant forget <fact-id>
hermes elephant prefs
hermes elephant dream
hermes elephant knowledge | research | procedures | intentions | state | audit
```

## Prospective memory: wiring intentions to hermes cron

Elephant records forward-looking commitments as `:Intention` nodes ("remind me
before the registration lapses"), but it is **pull-only by design** — it never
fires them, because an external scheduler is expected to own the clock. Hermes
*is* that scheduler.

```bash
hermes cron create '0 9 * * *' \
  'Run `hermes elephant intentions --due`. If anything is due, summarise each
   item and what I should do about it. If nothing is due, reply exactly "none"
   and do nothing else.' \
  --name 'elephant due intentions' \
  --deliver telegram
```

This drives the CLI rather than the memory tools deliberately: cron agents run
in a non-primary agent context with a reduced tool surface, but they always have
a terminal.

Pair it with a consolidation cycle if you would rather drive dreaming from
hermes than from elephant's own scheduler:

```bash
hermes cron create '0 4 * * *' 'Run `hermes elephant dream`.' --name 'elephant dream'
```

## Development

Tests live one level up (`adapters/hermes/tests/`) and run without a hermes
checkout or a live service:

```bash
uv run --with pytest pytest -q
```

The live suite runs against a real service on a throwaway Neo4j testcontainer:

```bash
pnpm test:hermes-live    # from the elephant repo root
```
