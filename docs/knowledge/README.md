# Elephant knowledge notes

These notes are seeded into Cerebro's Commons knowledge by cerebro-stack (`bin/stack seed-knowledge`), one note
per file. This index is not seeded. Keep each note self-contained and verified against the code; see the
"Knowledge notes" section of the repo's `CLAUDE.md`.

| File | Title | What it covers |
|---|---|---|
| [elephant-overview.md](elephant-overview.md) | Elephant: overview and role in the stack | what Elephant is, units, ports, paths, health, auth token, who calls it, design rules |
| [elephant-data-model.md](elephant-data-model.md) | Elephant: data model | memory categories, entities, relationships, vector/full-text indexes, audit history, episode details |
| [elephant-time-and-forgetting.md](elephant-time-and-forgetting.md) | Elephant: time, supersede and forgetting | bi-temporal clocks, supersede/merge/prune/redaction, the forgetting curve, the few hard deletes |
| [elephant-scopes.md](elephant-scopes.md) | Elephant: memory scopes | the four scope axes, five modes, defaults per route, scope on writes and in dreaming |
| [elephant-recall.md](elephant-recall.md) | Elephant: how recall works | the retrieval pipeline, RRF and blended scoring, query parameters, score vs vectorScore |
| [elephant-dreaming.md](elephant-dreaming.md) | Elephant: the dream cycle | what a cycle does, triggering and monitoring, backlog and dead letters, re-queue and rebuild |
| [elephant-knowledge-and-research.md](elephant-knowledge-and-research.md) | Elephant: knowledge documents, research, attachments and the OKF vault | document/research ingestion, attachment extraction and its worker, the markdown vault and `okf:sync` |
| [elephant-media-settings.md](elephant-media-settings.md) | Elephant: attachment OCR and transcription settings | `KNOWLEDGE_VISION_*`/`KNOWLEDGE_TRANSCRIBE_*`, opt-in rule, `/admin/settings/knowledge-media`, encrypted store |
| [elephant-http-api.md](elephant-http-api.md) | Elephant: HTTP API reference | envelope, status codes, every route with its purpose, curl examples |
| [elephant-configuration.md](elephant-configuration.md) | Elephant: configuration | env vars and defaults, which keys the stack owns, providers, dream/retrieval/retention settings |
| [elephant-operations.md](elephant-operations.md) | Elephant: operations (start, stop, logs, upgrade, migrations, dashboard) | systemd units, bin/stack commands, background jobs, migrations, maintenance scripts, dashboard |
| [elephant-backup-restore.md](elephant-backup-restore.md) | Elephant: backup and restore | what to back up, `bin/stack backup`, `backup-neo4j.py`, restore paths and caveats |
| [elephant-embedding-model-change.md](elephant-embedding-model-change.md) | Elephant: changing the embedding model | why the model is pinned, mismatch symptoms, the `pnpm reembed` procedure |
| [elephant-troubleshooting.md](elephant-troubleshooting.md) | Elephant: troubleshooting | restart loops, health failures, missing memories, recall problems, dream issues, GPU contention, attachments |
| [elephant-security.md](elephant-security.md) | Elephant: security model and limits | token, network exposure, scope vs auth, data leaving the host, secrets at rest, limits |
| [elephant-clients-and-adapters.md](elephant-clients-and-adapters.md) | Elephant: client package and adapters | the TypeScript client, MCP server, OpenClaw and hermes adapters, caller conventions |
