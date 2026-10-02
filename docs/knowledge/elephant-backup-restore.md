---
title: "Elephant: backup and restore"
tags: [elephant, backup, restore, neo4j]
---

Elephant's durable state is in three places. Back up all three together:

| State | Where (stack install) | Backed up by `bin/stack backup` as |
|---|---|---|
| The graph (all memory) | Neo4j docker volumes | `elephant/neo4j-<stamp>.cypher.gz` (online APOC dump) |
| Attachment files | `$STACK_ROOT/data/elephant-blobs` (`KNOWLEDGE_BLOB_DIR`) | `elephant/blobs.tar.gz` |
| Encrypted runtime settings | `$STACK_ROOT/data/elephant-state` (`ELEPHANT_STATE_DIR`) | `elephant/elephant-state.tar.gz` (readable only with `ELEPHANT_SETTINGS_KEY`, which is in `stack/secrets.env` of the same backup) |

The OKF markdown vault is derived and is not backed up; regenerate it with `pnpm okf:sync`. Without the graph,
attachments are orphaned files, and without the blobs, attachment downloads fail (their extracted text stays
searchable, since it lives in the graph).

## Taking a backup

The normal path is the whole-stack backup, which runs daily from `stack-backup.timer` (02:30) and on demand:

```bash
cd /home/cerebro/cerebro-stack
bin/stack backup                 # -> $STACK_ROOT/backups/stack-YYYYmmdd-HHMMSS/, rotated to BACKUP_KEEP (14)
ls -l /home/cerebro/stack/backups/stack-*/elephant/
```

A component that fails is listed in an `INCOMPLETE` file in that directory and the command exits non-zero; the
rest of the backup is still usable.

Just the graph, ad hoc (for example before a risky script):

```bash
cd /home/cerebro/stack/elephant
python3 scripts/backup-neo4j.py
# [backup] wrote <BACKUP_DIR>/neo4j-<stamp>.cypher.gz (N bytes, X nodes, Y rels)
```

`backup-neo4j.py` needs no root and no downtime: it calls `apoc.export.cypher.all` over Neo4j's HTTP API
(`NEO4J_HTTP`, default `http://127.0.0.1:7474`) with `NEO4J_USER`/`NEO4J_PASSWORD` from `.env`, gzips the Cypher to
`BACKUP_DIR` (Elephant's `.env` sets `$STACK_ROOT/backups/neo4j-daily`; the script's own default is
`~/backups/neo4j`) and keeps the newest `BACKUP_KEEP` (14). It refuses to write an empty dump. The whole export
travels in one HTTP response with a 300 s timeout, so a very large graph may need a longer window. Success line:
`[backup] wrote ... (N bytes, X nodes, Y rels)`; note the node and relationship counts to compare after a restore.

## Restoring

`scripts/restore-neo4j.py [FILE] [--yes] [--force]` replays a dump through `apoc.cypher.runMany` over the HTTP API.
Without `FILE` it takes the newest `neo4j-*.cypher.gz` in `BACKUP_DIR`. It is meant for a database with no data: it
counts the real nodes first (everything except the `:SchemaMigration` and `:SystemState` bookkeeping nodes that every
migration writes) and refuses (`target DB already holds data (N nodes ...)`) unless `--force`, because replaying into
existing data duplicates nodes. Before replaying, it deletes the bookkeeping nodes and prints how many it removed;
the dump recreates them (it carries the source's copies, under unique constraints).

Whole-stack restore (new host, or after losing the Neo4j volume):

```bash
cd /home/cerebro/cerebro-stack
bin/stack restore /home/cerebro/stack/backups/stack-YYYYmmdd-HHMMSS --yes
bin/stack up && bin/stack doctor
```

This restores secrets, re-renders every `.env`, unpacks `elephant-blobs` and `elephant-state`, starts neo4j and
elephant (which runs the migration), and then runs `restore-neo4j.py <dump> --yes`. Add `--force-graph` to pass
`--force` through.

A fresh, freshly migrated database is fine: the bookkeeping nodes the migration wrote do not count as data and are
replaced by the dump's copies, so no `--force-graph` is needed. After any restore, compare the node count the script prints (`[restore] done. node count now N`)
with the count logged when the backup was taken, and check `/health` (`neo4j: true`, `schemaEmbedModel` equal to
`embedModel`).

Graph-only restore on an existing install (data loss, so only when the graph is damaged):

1. `bin/stack down elephant` so nothing writes during the restore (Neo4j keeps running).
2. Take one more backup of the current state: `cd /home/cerebro/stack/elephant && python3 scripts/backup-neo4j.py`.
3. Empty the database: `pnpm wipe --yes` (deletes all nodes, keeps indexes and constraints). This wipe-then-restore path is how you restore over existing data; `--force` would duplicate it instead.
4. `python3 scripts/restore-neo4j.py /path/to/neo4j-<stamp>.cypher.gz --yes`.
5. `bin/stack up elephant` (the migration re-applies anything missing) and check `/health` and the node count.

The embedding model recorded in the dump must match the configured one, or Elephant will refuse to start; restore
the matching `.env` settings, or re-embed (see *Elephant: changing the embedding model*).

## Before risky operations

Back up the graph before any `scripts/backfill-*.ts`, `pnpm rebuild:facts`, `pnpm reembed`, `pnpm wipe`, a
manual Cypher write, or an embedding/provider change. None of them is reversible without a backup.
