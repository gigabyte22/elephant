#!/usr/bin/env python3
"""Online logical backup of the elephant Neo4j graph.

Streams a full, type-faithful Cypher dump over the HTTP API (APOC
apoc.export.cypher.all with stream:true) and writes it gzipped to the backup
directory, then rotates old backups. Works as an unprivileged user:
no `docker exec`, no sudo, no in-container file write — the dump comes back over
the wire on port 7474.

Why this exists: on 2026-06-09 a stray `bun test` in this repo wiped the live
graph and there was NO backup. See tests/integration/guard.ts and the
elephant-tests-wipe-live-db memory note.

Restore with scripts/restore-neo4j.py.

Env (read from elephant/.env, overridable):
  NEO4J_HTTP   default http://127.0.0.1:7474
  NEO4J_USER   default neo4j
  NEO4J_PASSWORD
  NEO4J_DATABASE default neo4j
  BACKUP_DIR   default ~/backups/neo4j
  BACKUP_KEEP  default 14
"""
import base64
import datetime as dt
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
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return vals


def main():
    env = load_env_file(ENV_FILE)

    def cfg(key, default):
        return os.environ.get(key) or env.get(key) or default

    http = cfg("NEO4J_HTTP", "http://127.0.0.1:7474").rstrip("/")
    user = cfg("NEO4J_USER", "neo4j")
    password = cfg("NEO4J_PASSWORD", "neo4j-dev")
    database = cfg("NEO4J_DATABASE", "neo4j")
    backup_dir = cfg("BACKUP_DIR", os.path.expanduser("~/backups/neo4j"))
    keep = int(cfg("BACKUP_KEEP", "14"))

    os.makedirs(backup_dir, exist_ok=True)

    auth = base64.b64encode(f"{user}:{password}".encode()).decode()
    stmt = (
        "CALL apoc.export.cypher.all(null,{stream:true,format:'plain',"
        "useOptimizations:{type:'NONE'}}) "
        "YIELD nodes,relationships,cypherStatements "
        "RETURN nodes,relationships,cypherStatements"
    )
    body = json.dumps({"statements": [{"statement": stmt}]}).encode()
    req = urllib.request.Request(
        f"{http}/db/{database}/tx/commit",
        data=body,
        method="POST",
        headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        payload = json.load(resp)

    if payload.get("errors"):
        print(f"[backup] neo4j errors: {payload['errors']}", file=sys.stderr)
        return 1

    rows = payload["results"][0]["data"]
    if not rows:
        print("[backup] export returned no rows", file=sys.stderr)
        return 1

    nodes = rels = 0
    parts = []
    for r in rows:
        n, rel, cy = r["row"]
        nodes = max(nodes, n or 0)
        rels = max(rels, rel or 0)
        if cy:
            parts.append(cy)
    cypher = "".join(parts)
    if not cypher.strip():
        print("[backup] empty cypher dump — refusing to write", file=sys.stderr)
        return 1

    # Stamp passed in via env so this stays reproducible; fall back to now.
    stamp = os.environ.get("BACKUP_STAMP") or dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = os.path.join(backup_dir, f"neo4j-{stamp}.cypher.gz")
    with gzip.open(out, "wt", encoding="utf-8") as f:
        f.write(cypher)
    size = os.path.getsize(out)
    print(f"[backup] wrote {out} ({size:,} bytes, {nodes} nodes, {rels} rels)")

    # Rotate: keep newest `keep`.
    files = sorted(glob.glob(os.path.join(backup_dir, "neo4j-*.cypher.gz")))
    for old in files[:-keep] if keep > 0 else []:
        os.remove(old)
        print(f"[backup] rotated out {os.path.basename(old)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
