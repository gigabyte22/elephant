#!/usr/bin/env python3
"""Restore a elephant Neo4j graph from a backup written by backup-neo4j.py.

Replays the gzipped Cypher dump over the HTTP API via apoc.cypher.runMany
(server-side statement splitting). Intended for an EMPTY/freshly-wiped database
(schema already applied by `pnpm migrate`) — restoring over existing data would
duplicate nodes, so this refuses to run against a non-empty DB unless --force.

Usage:
  python3 scripts/restore-neo4j.py [BACKUP_FILE] [--yes] [--force]

  BACKUP_FILE  path to a neo4j-*.cypher.gz; defaults to the newest in BACKUP_DIR.
  --yes        skip the interactive confirmation.
  --force      allow restoring into a non-empty DB (duplicates possible).

Env mirrors backup-neo4j.py (NEO4J_HTTP/USER/PASSWORD/DATABASE, BACKUP_DIR).
"""
import base64
import glob
import gzip
import json
import os
import sys
import urllib.request

ENV_FILE = os.path.join(os.path.dirname(__file__), "..", ".env")


def load_env_file(path):
    vals = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    vals[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return vals


def main():
    args = [a for a in sys.argv[1:]]
    yes = "--yes" in args
    force = "--force" in args
    positional = [a for a in args if not a.startswith("--")]

    env = load_env_file(ENV_FILE)

    def cfg(key, default):
        return os.environ.get(key) or env.get(key) or default

    http = cfg("NEO4J_HTTP", "http://127.0.0.1:7474").rstrip("/")
    user = cfg("NEO4J_USER", "neo4j")
    password = cfg("NEO4J_PASSWORD", "neo4j-dev")
    database = cfg("NEO4J_DATABASE", "neo4j")
    backup_dir = cfg("BACKUP_DIR", os.path.expanduser("~/backups/neo4j"))

    backup_file = positional[0] if positional else None
    if not backup_file:
        files = sorted(glob.glob(os.path.join(backup_dir, "neo4j-*.cypher.gz")))
        if not files:
            print(f"[restore] no backups in {backup_dir}", file=sys.stderr)
            return 1
        backup_file = files[-1]

    auth = base64.b64encode(f"{user}:{password}".encode()).decode()

    def run(stmt, params=None):
        body = json.dumps({"statements": [{"statement": stmt, "parameters": params or {}}]}).encode()
        req = urllib.request.Request(
            f"{http}/db/{database}/tx/commit",
            data=body,
            method="POST",
            headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.load(resp)

    # Refuse to clobber a populated DB unless forced.
    cnt = run("MATCH (n) RETURN count(n) AS c")
    if cnt.get("errors"):
        print(f"[restore] connectivity error: {cnt['errors']}", file=sys.stderr)
        return 1
    existing = cnt["results"][0]["data"][0]["row"][0]
    if existing and not force:
        print(
            f"[restore] target DB is not empty ({existing} nodes). Restoring would duplicate "
            "data. Wipe first (pnpm migrate on a fresh DB) or pass --force.",
            file=sys.stderr,
        )
        return 1

    with gzip.open(backup_file, "rt", encoding="utf-8") as f:
        cypher = f.read()

    print(f"[restore] file={backup_file}")
    print(f"[restore] target={http} db={database} existing_nodes={existing}")
    if not yes:
        ans = input("[restore] proceed? type 'yes': ").strip()
        if ans != "yes":
            print("[restore] aborted.")
            return 1

    res = run("CALL apoc.cypher.runMany($cypher, {}, {statistics:false})", {"cypher": cypher})
    if res.get("errors"):
        print(f"[restore] FAILED: {res['errors']}", file=sys.stderr)
        return 1

    after = run("MATCH (n) RETURN count(n) AS c")["results"][0]["data"][0]["row"][0]
    print(f"[restore] done. node count now {after}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
