# Deploying Elephant with systemd

Example units for running Elephant on boot on a Linux host with Docker:

- `elephant-neo4j.service` — brings up the Neo4j container via `docker compose
  up -d --force-recreate` and waits for Bolt (7687) to accept connections.
  Recreating instead of starting sidesteps AppArmor issues seen with Docker
  inside unprivileged LXC containers; data lives in named volumes and persists.
- `elephant.service` — runs the schema migration (idempotent) and then the
  memory service, reading config from `.env` in the repo root.
- `elephant.service.d/neo4j.conf` — drop-in ordering elephant after Neo4j.

The unit files use `__ELEPHANT_USER__`, `__ELEPHANT_GROUP__`, and
`__ELEPHANT_DIR__` placeholders. `install-boot-units.sh` substitutes them
(defaulting to the sudo-invoking user and this repo's root), installs the units
into `/etc/systemd/system/`, and enables them:

```bash
sudo bash deploy/install-boot-units.sh
# or with overrides:
sudo ELEPHANT_USER=svc ELEPHANT_DIR=/opt/elephant bash deploy/install-boot-units.sh
```

Note: if you previously installed units under the old name
`neo4j-memlayer.service`, disable and remove them first
(`systemctl disable --now neo4j-memlayer.service`).
