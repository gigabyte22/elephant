# Deploying Elephant with systemd

Example units for running Elephant on boot on a Linux host with Docker:

- `elephant-neo4j.service` — brings up the Neo4j container via `docker compose
  up -d --force-recreate` and waits for Bolt (7687) to accept connections.
  Recreating instead of starting sidesteps AppArmor issues seen with Docker
  inside unprivileged LXC containers; data lives in named volumes and persists.
- `elephant.service` — runs the schema migration (idempotent) and then the
  memory service, reading config from `.env` in the repo root.
- `elephant.service.d/neo4j.conf` — drop-in ordering elephant after Neo4j.
- `elephant-backup.service` + `elephant-backup.timer` — a daily online dump of
  the graph via `scripts/backup-neo4j.py` (APOC export over the HTTP API, so no
  downtime and no root). Dumps land in `BACKUP_DIR` (default `~/backups/neo4j`,
  set it in `.env`) and the newest `BACKUP_KEEP` (default 14) are kept. Restore
  with `scripts/restore-neo4j.py` into an empty, migrated database.

`docker-compose.yml` publishes Neo4j on `127.0.0.1` only and refuses to start
unless `NEO4J_PASSWORD` is set.

The unit files use `__ELEPHANT_USER__`, `__ELEPHANT_GROUP__`, and
`__ELEPHANT_DIR__` placeholders. `install-boot-units.sh` substitutes them
(defaulting to the sudo-invoking user and this repo's root), installs the units
into `/etc/systemd/system/`, and enables them (the backup timer is also started):

```bash
sudo bash deploy/install-boot-units.sh
# or with overrides:
sudo ELEPHANT_USER=svc ELEPHANT_DIR=/opt/elephant bash deploy/install-boot-units.sh
```

Check the backup schedule with `systemctl list-timers elephant-backup.timer`.

## Running the service in Docker

The repo's `Dockerfile` builds the service and dashboard into one image that
runs the (idempotent) migration and then serves. `docker compose --profile app
up -d` starts it next to Neo4j, reading `.env`; it keeps attachment blobs and
the OKF vault in the `elephant-data` volume.
