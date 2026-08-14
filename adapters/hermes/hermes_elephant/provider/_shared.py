"""Constants and formatters shared by the provider and its CLI.

These live in a sibling module rather than in ``__init__.py`` because of how
hermes loads a directory-installed provider. It registers the plugin package as
a synthetic shell with no ``__file__`` and execs each ``*.py`` as a submodule
*before* the package body runs, so a parent-attribute import (``from . import
DEFAULT_URL``) raises ``ImportError: cannot import name ... (unknown location)``
and takes ``hermes elephant`` down with it. Submodule imports (``from ._shared
import ...``) resolve through the shell's ``__path__`` and work.

Stdlib-only and side-effect-free: hermes execs this file in every process that
touches memory discovery.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

CONFIG_FILE = "elephant.json"
TOKEN_ENV = "ELEPHANT_SERVICE_TOKEN"
DEFAULT_URL = "http://127.0.0.1:18790"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _user_aliases(config: Dict[str, Any]) -> Dict[str, str]:
    """The ``user_aliases`` map from elephant.json: platform user id (or display
    name) -> canonical elephant userId. Lets one human's Slack, Telegram, and
    display-name identities land in a single memory bucket. Defensive: anything
    that isn't a str->str dict collapses to empty."""
    raw = config.get("user_aliases")
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if k and v}


def _resolve_user_id(
    file_cfg: Dict[str, Any],
    runtime_user_id: Any = None,
    runtime_user_id_alt: Any = None,
) -> Optional[str]:
    """The elephant userId for this provider instance: runtime identity from the
    hermes gateway (the ``initialize`` kwargs), alias-mapped, else the config
    file. Runtime always wins — a config value that overrode it would silently
    merge every human on the gateway into one memory bucket. The file's
    ``user_id`` is the fallback for single-user installs and the CLI, which have
    no runtime identity at all."""
    runtime = str(runtime_user_id or runtime_user_id_alt or "")
    if runtime:
        return _user_aliases(file_cfg).get(runtime, runtime)
    return file_cfg.get("user_id") or None


def _scope_of(config: Dict[str, Any]) -> Dict[str, Any]:
    """The configured scope axes, omitting any that are unset. An empty dict
    means unscoped/shared, which is correct: `_qs` and the JSON bodies drop
    absent keys rather than filtering on a literal null. Shared with the CLI so
    a document written there lands in the same scope as one written by a tool."""
    scope: Dict[str, Any] = {}
    if config.get("project_id"):
        scope["projectId"] = config["project_id"]
    if config.get("user_id"):
        scope["userId"] = config["user_id"]
    return scope


# The gateway's shared-session marker: "[Dana] actual message". Bounded and
# anchored so ordinary bracketed text deeper in a message never matches.
_SPEAKER_PREFIX_RE = re.compile(r"^\[([^\[\]\n]{1,64})\]\s+(.+)$", re.S)


def _split_speaker_prefix(text: str) -> Optional[Tuple[str, str]]:
    """(label, rest) when ``text`` opens with hermes's shared-session speaker
    prefix, else None — the single-user path must stay byte-identical."""
    match = _SPEAKER_PREFIX_RE.match(text or "")
    if not match:
        return None
    label = match.group(1).strip()
    return (label, match.group(2)) if label else None


def _detail(header: str, item: Dict[str, Any]) -> str:
    """One-line summary followed by the item's full body."""
    return f"{header}\n\n{item.get('content') or '(no content)'}"


def _load_file_config(hermes_home: str) -> Dict[str, Any]:
    path = os.path.join(hermes_home, CONFIG_FILE)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _items(data: Dict[str, Any], key: str) -> List[Dict[str, Any]]:
    """Recall sections, defensively: a missing key, a null, or a non-list all
    collapse to empty, and non-dict members are dropped. Formatting runs on the
    prefetch path, where a shape change must degrade rather than raise."""
    value = data.get(key) if isinstance(data, dict) else None
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _clip(value: Any, limit: int = 180) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _format_fact(fact: Dict[str, Any]) -> str:
    bits = []
    score = fact.get("score")
    if isinstance(score, (int, float)) and not isinstance(score, bool):
        bits.append(f"{score:.2f}")
    if fact.get("category"):
        bits.append(str(fact["category"]))
    meta = f" ({', '.join(bits)})" if bits else ""
    return f"- [{fact.get('id')}]{meta} {fact.get('content')}"


def _format_document(doc: Dict[str, Any]) -> str:
    summary = _clip(doc.get("summary")) if doc.get("summary") else ""
    tags = ", ".join(str(t) for t in doc.get("tags") or [])
    line = f"- [{doc.get('id')}] {doc.get('title')} ({doc.get('source')})"
    if tags:
        line += f" #{tags}"
    return f"{line} — {summary}" if summary else line


def _format_procedure(proc: Dict[str, Any]) -> str:
    return (
        f"- [{proc.get('id')}] {proc.get('name')} (v{proc.get('version')}): {proc.get('whenToUse')}"
    )


def _format_intention(intention: Dict[str, Any]) -> str:
    meta = str(intention.get("status"))
    if intention.get("dueAt"):
        meta += f", due {intention['dueAt']}"
    if intention.get("recurring"):
        schedule = intention.get("schedule")
        meta += f", recurring {schedule}" if schedule else ", recurring"
    return f"- [{intention.get('id')}] ({meta}) {intention.get('content')}"



def _format_recall(data: Dict[str, Any]) -> str:
    sections: List[str] = []

    prefs = _items(data, "preferences")
    if prefs:
        sections.append(
            "Preferences:\n" + "\n".join(f"- {p.get('key')}: {p.get('value')}" for p in prefs)
        )

    facts = _items(data, "facts")
    if facts:
        sections.append("Facts:\n" + "\n".join(_format_fact(f) for f in facts))

    insights = _items(data, "insights")
    if insights:
        sections.append("Insights:\n" + "\n".join(f"- {i.get('content')}" for i in insights))

    procedures = _items(data, "procedures")
    if procedures:
        sections.append("Procedures:\n" + "\n".join(_format_procedure(p) for p in procedures))

    knowledge = _items(data, "knowledgeChunks")
    if knowledge:
        sections.append(
            "Knowledge:\n"
            + "\n".join(f"- [{k.get('documentId')}] {_clip(k.get('text'))}" for k in knowledge)
        )

    research = _items(data, "research")
    if research:
        sections.append("Research:\n" + "\n".join(_format_document(r) for r in research))

    research_chunks = _items(data, "researchChunks")
    if research_chunks:
        sections.append(
            "Research excerpts:\n"
            + "\n".join(f"- [{c.get('researchId')}] {_clip(c.get('text'))}" for c in research_chunks)
        )

    intentions = _items(data, "intentions")
    if intentions:
        sections.append("Open intentions:\n" + "\n".join(_format_intention(i) for i in intentions))

    return "\n\n".join(sections)


