"""Optional CLI: `hermes elephant status|recall|save|forget|prefs|dream|...`.

Loaded by hermes only when the elephant provider is active. Scope handling
mirrors the provider dispatch path — a fact saved from the CLI must land in the
same scope, and be recalled by the same ranking, as one saved from a tool call.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Tuple

from . import (
    DEFAULT_URL,
    TOKEN_ENV,
    UUID_RE,
    _detail,
    _format_document,
    _format_intention,
    _format_procedure,
    _format_recall,
    _load_file_config,
    _scope_of,
)
from .client import ElephantClient

CLI_SESSION = "hermes:cli"


def _client() -> Tuple[ElephantClient, Dict[str, Any]]:
    hermes_home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    cfg = _load_file_config(hermes_home)
    token = os.environ.get(TOKEN_ENV, "")
    if not token:
        raise SystemExit(f"{TOKEN_ENV} is not set — run `hermes memory setup`")
    url = os.environ.get("ELEPHANT_URL") or cfg.get("url") or DEFAULT_URL
    return ElephantClient(url, token), cfg


def register_cli(subparser) -> None:  # noqa: ANN001 — argparse subparser supplied by hermes
    parser = subparser.add_parser("elephant", help="Elephant memory service")
    sub = parser.add_subparsers(dest="elephant_cmd", required=True)

    sub.add_parser("status", help="Service health")
    recall = sub.add_parser("recall", help="Search long-term memory")
    recall.add_argument("query", nargs="+")
    recall.add_argument("--limit", type=int, default=10)
    save = sub.add_parser("save", help="Save a fact")
    save.add_argument("fact", nargs="+")
    save.add_argument("--category")
    forget = sub.add_parser("forget", help="Soft-delete a fact by id")
    forget.add_argument("fact_id")
    sub.add_parser("prefs", help="List active preferences")
    sub.add_parser("dream", help="Trigger a consolidation cycle")

    knowledge = sub.add_parser("knowledge", help="List knowledge documents, or show one by id")
    knowledge.add_argument("doc_id", nargs="?")
    knowledge.add_argument("--limit", type=int, default=20)

    research = sub.add_parser("research", help="List research records, or show one by id")
    research.add_argument("research_id", nargs="?")
    research.add_argument("--limit", type=int, default=20)

    procedures = sub.add_parser("procedures", help="List procedures, or show one by id")
    procedures.add_argument("procedure_id", nargs="?")
    procedures.add_argument("--limit", type=int, default=20)

    intentions = sub.add_parser("intentions", help="List intentions")
    intentions.add_argument("--status")
    intentions.add_argument("--due", action="store_true", help="Only open intentions now due")
    intentions.add_argument("--limit", type=int, default=20)

    state = sub.add_parser("state", help="List working-state keys, or read one")
    state.add_argument("key", nargs="?")
    state.add_argument("--prefix")
    state.add_argument("--session", default=CLI_SESSION)

    audit = sub.add_parser("audit", help="Show audit history for a memory item")
    audit.add_argument("target_id")
    audit.add_argument("--limit", type=int, default=50)

    parser.set_defaults(func=_run)


def _run(args) -> None:  # noqa: ANN001 — argparse namespace
    client, cfg = _client()
    cmd = args.elephant_cmd
    agent_id = cfg.get("agent_id") or "hermes"
    scope = _scope_of(cfg)

    if cmd == "status":
        print(json.dumps(client.health(), indent=2))

    elif cmd == "recall":
        data = client.recall(
            q=" ".join(args.query),
            agentId=agent_id,
            projectId=cfg.get("project_id"),
            userId=cfg.get("user_id"),
            agentScope="boost",
            projectScope="boost" if cfg.get("project_id") else "none",
            userScope="boost" if cfg.get("user_id") else "none",
            limit=args.limit,
            includePreferences=True,
            includeInsights=True,
            includeProcedures=True,
            includeKnowledge=True,
            includeResearch=True,
            includeIntentions=True,
        )
        print(_format_recall(data) or "No matches.")

    elif cmd == "save":
        saved = client.save_fact(
            content=" ".join(args.fact),
            category=args.category,
            agentId=agent_id,
            sessionId=CLI_SESSION,
            projectId=cfg.get("project_id"),
            userId=cfg.get("user_id"),
            actor="hermes:cli",
        )
        print(f"Saved fact {saved.get('id')}")

    elif cmd == "forget":
        # Same guard as the tool path: never put a path-shaped argument on the wire.
        if not UUID_RE.match(str(args.fact_id)):
            raise SystemExit("fact_id must be a UUID.")
        client.delete_fact(args.fact_id)
        print(f"Soft-deleted fact {args.fact_id}")

    elif cmd == "prefs":
        for pref in client.list_preferences().get("preferences") or []:
            print(f"{pref.get('key')}: {pref.get('value')}")

    elif cmd == "dream":
        job = client.trigger_dream()
        print(f"Dream triggered, job {job.get('jobId')}")

    elif cmd == "knowledge":
        if args.doc_id:
            doc = client.get_knowledge(args.doc_id)
            print(_detail(_format_document(doc), doc))
        else:
            docs = client.list_knowledge(**scope, limit=args.limit)
            print("\n".join(_format_document(d) for d in docs) or "No knowledge documents.")

    elif cmd == "research":
        if args.research_id:
            record = client.get_research(args.research_id, cfg.get("project_id"))
            print(_detail(_format_document(record), record))
        elif not cfg.get("project_id"):
            raise SystemExit("research listing requires project_id in elephant.json")
        else:
            records = client.list_research(
                cfg["project_id"], userId=cfg.get("user_id"), limit=args.limit
            )
            print("\n".join(_format_document(r) for r in records) or "No research records.")

    elif cmd == "procedures":
        if args.procedure_id:
            proc = client.get_procedure(args.procedure_id)
            print(_detail(_format_procedure(proc), proc))
        else:
            procs = client.list_procedures(**scope, limit=args.limit)
            print("\n".join(_format_procedure(p) for p in procs) or "No procedures.")

    elif cmd == "intentions":
        params = dict(scope, agentId=agent_id, limit=args.limit)
        if args.status:
            params["status"] = args.status
        listing = (
            client.list_due_intentions(**params) if args.due else client.list_intentions(**params)
        )
        print("\n".join(_format_intention(i) for i in listing) or "No intentions.")

    elif cmd == "state":
        params = dict(scope, agentId=agent_id, sessionId=args.session)
        if args.key:
            entry = client.get_state(args.key, **params)
            print(f"{entry.get('key')} = {json.dumps(entry.get('value'))}")
        else:
            entries = client.list_state(**params, prefix=args.prefix)
            print(
                "\n".join(f"{e.get('key')} = {json.dumps(e.get('value'))}" for e in entries)
                or "No state keys."
            )

    elif cmd == "audit":
        if not UUID_RE.match(str(args.target_id)):
            raise SystemExit("target_id must be a UUID.")
        data = client.audit(args.target_id, args.limit)
        for event in data.get("events") or []:
            print(f"{event.get('at')} {event.get('kind')} by {event.get('actor') or 'unknown'}")
        for revision in data.get("revisions") or []:
            print(
                f"revision {revision.get('id')} archived {revision.get('archivedAt')}"
                f" ({revision.get('reason')})"
            )
