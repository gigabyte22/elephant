"""Optional CLI: `hermes elephant status|recall|save|forget|prefs|dream`.

Loaded by hermes only when the elephant provider is active.
"""

from __future__ import annotations

import json
import os

from . import DEFAULT_URL, TOKEN_ENV, _format_recall, _load_file_config
from .client import ElephantClient


def _client() -> ElephantClient:
    hermes_home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    cfg = _load_file_config(hermes_home)
    token = os.environ.get(TOKEN_ENV, "")
    if not token:
        raise SystemExit(f"{TOKEN_ENV} is not set — run `hermes memory setup`")
    return ElephantClient(os.environ.get("ELEPHANT_URL") or cfg.get("url") or DEFAULT_URL, token)


def register_cli(subparser) -> None:  # noqa: ANN001 — argparse subparser supplied by hermes
    parser = subparser.add_parser("elephant", help="Elephant memory service")
    sub = parser.add_subparsers(dest="elephant_cmd", required=True)

    sub.add_parser("status", help="Service health")
    recall = sub.add_parser("recall", help="Search long-term memory")
    recall.add_argument("query", nargs="+")
    save = sub.add_parser("save", help="Save a fact")
    save.add_argument("fact", nargs="+")
    forget = sub.add_parser("forget", help="Soft-delete a fact by id")
    forget.add_argument("fact_id")
    sub.add_parser("prefs", help="List active preferences")
    sub.add_parser("dream", help="Trigger a consolidation cycle")

    parser.set_defaults(func=_run)


def _run(args) -> None:  # noqa: ANN001 — argparse namespace
    client = _client()
    cmd = args.elephant_cmd
    if cmd == "status":
        print(json.dumps(client.health(), indent=2))
    elif cmd == "recall":
        data = client.recall(q=" ".join(args.query), includePreferences=True, includeInsights=True)
        print(_format_recall(data) or "No matches.")
    elif cmd == "save":
        saved = client.save_fact(content=" ".join(args.fact), actor="hermes:cli")
        print(f"Saved fact {saved.get('id')}")
    elif cmd == "forget":
        client.delete_fact(args.fact_id)
        print(f"Soft-deleted fact {args.fact_id}")
    elif cmd == "prefs":
        for pref in client.list_preferences().get("preferences") or []:
            print(f"{pref['key']}: {pref['value']}")
    elif cmd == "dream":
        job = client.trigger_dream()
        print(f"Dream triggered, job {job.get('jobId')}")
