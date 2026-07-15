"""Elephant memory provider for hermes-agent.

Backs hermes's pluggable memory interface with the elephant memory service:
hybrid GraphRAG recall, bi-temporal facts, versioned preferences, and nightly
consolidation (dreaming) on Neo4j. Stdlib-only — no pip dependencies.

Hook mapping:
  prefetch          -> GET /recall (query-conditioned context block)
  sync_turn         -> POST /episodes via a non-blocking queue + daemon worker
  on_session_end    -> flush remaining queue
  on_pre_compress   -> POST /episodes (save the span before compaction drops it)
  on_memory_write   -> mirror built-in memory writes as facts
  tools             -> memory_recall/save/forget, timeline, entity,
                       preference get/set, observe
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import threading
from typing import Any, Dict, List, Optional

try:
    from agent.memory_provider import MemoryProvider
except ImportError:  # running outside a hermes checkout (tests, standalone)

    class MemoryProvider:  # type: ignore[no-redef]
        """Structural stand-in for hermes's ABC when hermes is not importable."""


from .client import ElephantClient, ElephantError

logger = logging.getLogger(__name__)

CONFIG_FILE = "elephant.json"
TOKEN_ENV = "ELEPHANT_SERVICE_TOKEN"
DEFAULT_URL = "http://127.0.0.1:18790"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

_SENTINEL = object()


def _load_file_config(hermes_home: str) -> Dict[str, Any]:
    path = os.path.join(hermes_home, CONFIG_FILE)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _format_fact(fact: Dict[str, Any]) -> str:
    bits = []
    if fact.get("score") is not None:
        bits.append(f"{fact['score']:.2f}")
    if fact.get("category"):
        bits.append(str(fact["category"]))
    meta = f" ({', '.join(bits)})" if bits else ""
    return f"- [{fact.get('id')}]{meta} {fact.get('content')}"


def _format_recall(data: Dict[str, Any]) -> str:
    sections: List[str] = []
    prefs = data.get("preferences") or []
    if prefs:
        sections.append("Preferences:\n" + "\n".join(f"- {p['key']}: {p['value']}" for p in prefs))
    facts = data.get("facts") or []
    if facts:
        sections.append("Facts:\n" + "\n".join(_format_fact(f) for f in facts))
    insights = data.get("insights") or []
    if insights:
        sections.append("Insights:\n" + "\n".join(f"- {i['content']}" for i in insights))
    procedures = data.get("procedures") or []
    if procedures:
        sections.append(
            "Procedures:\n"
            + "\n".join(f"- {p['name']} (v{p.get('version')}): {p.get('whenToUse')}" for p in procedures)
        )
    return "\n\n".join(sections)


class ElephantMemoryProvider(MemoryProvider):
    """Elephant memory: shared graph memory service with recall + dreaming."""

    def __init__(self) -> None:
        self._client: Optional[ElephantClient] = None
        self._config: Dict[str, Any] = {}
        self._session_id: str = ""
        self._queue: "queue.Queue[Any]" = queue.Queue()
        self._worker: Optional[threading.Thread] = None
        self._prefetch_cache: Dict[str, str] = {}
        self._prefetch_lock = threading.Lock()

    # ─ identity / readiness ─────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "elephant"

    def is_available(self) -> bool:
        return bool(os.environ.get(TOKEN_ENV))

    # ─ lifecycle ────────────────────────────────────────────────────────────

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        hermes_home = str(kwargs.get("hermes_home") or os.path.expanduser("~/.hermes"))
        file_cfg = _load_file_config(hermes_home)
        token = os.environ.get(TOKEN_ENV, "")
        if not token:
            raise RuntimeError(f"elephant: {TOKEN_ENV} is not set — run `hermes memory setup`")
        self._config = {
            "url": os.environ.get("ELEPHANT_URL") or file_cfg.get("url") or DEFAULT_URL,
            "agent_id": file_cfg.get("agent_id") or "hermes",
            "project_id": file_cfg.get("project_id") or None,
            "user_id": file_cfg.get("user_id") or None,
            "auto_recall_limit": int(file_cfg.get("auto_recall_limit") or 8),
        }
        self._session_id = session_id
        self._client = ElephantClient(self._config["url"], token)
        try:
            health = self._client.health()
            if not health.get("neo4j"):
                logger.warning("elephant reachable but Neo4j is down — memory calls will fail")
        except Exception as err:  # noqa: BLE001 — degraded start beats a dead agent
            logger.warning("elephant not reachable at %s (%s) — continuing", self._config["url"], err)
        self._ensure_worker()

    def shutdown(self) -> None:
        if self._worker is not None:
            self._queue.put(_SENTINEL)
            self._worker.join(timeout=10)
            self._worker = None

    def on_session_switch(self, new_session_id: str, **kwargs: Any) -> None:
        self._session_id = new_session_id

    # ─ background episode writer ────────────────────────────────────────────

    def _ensure_worker(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            return
        self._worker = threading.Thread(target=self._drain, name="elephant-sync", daemon=True)
        self._worker.start()

    def _drain(self) -> None:
        while True:
            item = self._queue.get()
            try:
                if item is _SENTINEL:
                    return
                if self._client is not None:
                    self._client.ingest_episode(**item)
            except Exception as err:  # noqa: BLE001 — a failed write must not kill the worker
                logger.warning("elephant episode write failed: %s", err)
            finally:
                self._queue.task_done()

    def _enqueue_episode(self, transcript: str, session_id: str) -> None:
        if not transcript.strip() or self._client is None:
            return
        episode: Dict[str, Any] = {
            "agentId": self._config.get("agent_id", "hermes"),
            "sessionId": session_id or self._session_id or "hermes:default",
            "rawTranscript": transcript,
        }
        if self._config.get("project_id"):
            episode["projectId"] = self._config["project_id"]
        if self._config.get("user_id"):
            episode["userId"] = self._config["user_id"]
        self._ensure_worker()
        self._queue.put(episode)

    # ─ turn + session hooks ─────────────────────────────────────────────────

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        # MUST be non-blocking: enqueue only, the daemon worker does the POST.
        if len(user_content) + len(assistant_content) < 50:
            return
        transcript = f"USER: {user_content}\n\nASSISTANT: {assistant_content}"
        self._enqueue_episode(transcript, session_id)

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        # Turns already flowed through sync_turn; just give the queue a chance
        # to drain so short-lived processes don't drop the tail.
        try:
            self._queue.join()
        except Exception:  # noqa: BLE001
            pass

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        transcript = _transcript_of(messages)
        if len(transcript) >= 50:
            self._enqueue_episode(f"[pre-compression snapshot]\n\n{transcript}", self._session_id)
        return ""

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        # Mirror built-in memory writes so the graph sees them too. Deletes are
        # not mirrored — built-in targets don't map to fact ids.
        if self._client is None or action not in {"add", "append", "create", "write", "update"}:
            return
        if not content.strip():
            return
        try:
            self._client.save_fact(
                content=content.strip(),
                category="hermes-memory",
                agentId=self._config.get("agent_id", "hermes"),
                sessionId=self._session_id or None,
                projectId=self._config.get("project_id"),
                userId=self._config.get("user_id"),
                actor="hermes:builtin-mirror",
            )
        except Exception as err:  # noqa: BLE001
            logger.debug("elephant mirror write failed: %s", err)

    # ─ context injection ────────────────────────────────────────────────────

    def system_prompt_block(self) -> str:
        return (
            "Long-term memory is backed by the elephant service. Use memory_recall "
            "before assuming you lack context; save durable facts with memory_save; "
            "record user preferences with memory_preference_set."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        with self._prefetch_lock:
            cached = self._prefetch_cache.pop(query, None)
        if cached is not None:
            return cached
        return self._recall_block(query, session_id)

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        def _warm() -> None:
            block = self._recall_block(query, session_id)
            with self._prefetch_lock:
                self._prefetch_cache[query] = block

        threading.Thread(target=_warm, name="elephant-prefetch", daemon=True).start()

    def _recall_block(self, query: str, session_id: str) -> str:
        if self._client is None or not query.strip():
            return ""
        try:
            data = self._client.recall(
                q=query,
                agentId=self._config.get("agent_id", "hermes"),
                sessionId=session_id or self._session_id or None,
                projectId=self._config.get("project_id"),
                userId=self._config.get("user_id"),
                agentScope="boost",
                sessionScope="boost",
                projectScope="boost" if self._config.get("project_id") else "none",
                userScope="boost" if self._config.get("user_id") else "none",
                limit=self._config.get("auto_recall_limit", 8),
                includePreferences=True,
                includeInsights=True,
                includeProcedures=True,
            )
        except Exception as err:  # noqa: BLE001 — recall must never block the turn
            logger.debug("elephant prefetch failed: %s", err)
            return ""
        rendered = _format_recall(data)
        return f"[elephant memory]\n{rendered}" if rendered else ""

    # ─ tools ────────────────────────────────────────────────────────────────

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        def tool(name: str, description: str, properties: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
            return {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": {
                        "type": "object",
                        "properties": properties,
                        "required": required,
                    },
                },
            }

        return [
            tool(
                "memory_recall",
                "Recall facts, preferences, insights, and procedures from long-term memory. Supports temporal and importance filters.",
                {
                    "query": {"type": "string", "description": "Natural language query"},
                    "from": {"type": "string", "description": "ISO date lower bound"},
                    "to": {"type": "string", "description": "ISO date upper bound"},
                    "minImportance": {"type": "number", "minimum": 0, "maximum": 1},
                    "limit": {"type": "number", "minimum": 1, "maximum": 50},
                },
                ["query"],
            ),
            tool(
                "memory_save",
                "Save a durable fact to long-term memory (one sentence is best).",
                {
                    "fact": {"type": "string"},
                    "category": {"type": "string"},
                    "importance": {"type": "number", "minimum": 0, "maximum": 1},
                    "entities": {"type": "array", "items": {"type": "string"}},
                },
                ["fact"],
            ),
            tool(
                "memory_forget",
                "Soft-delete a fact by id (preferred) or query. A fuzzy query never bulk-deletes.",
                {
                    "factId": {"type": "string", "description": "Exact fact UUID (preferred)"},
                    "query": {"type": "string"},
                },
                [],
            ),
            tool(
                "memory_timeline",
                "Bi-temporal query: facts (optionally about one entity) or a preference as valid at a given instant.",
                {
                    "at": {"type": "string", "description": "ISO timestamp"},
                    "entity": {"type": "string"},
                    "preferenceKey": {"type": "string"},
                },
                ["at"],
            ),
            tool(
                "memory_entity",
                "Fuzzy-search entities by name, or fetch one with its fact subgraph by id.",
                {"name": {"type": "string"}, "id": {"type": "string"}},
                [],
            ),
            tool("memory_preference_get", "Read a user preference by key.", {"key": {"type": "string"}}, ["key"]),
            tool(
                "memory_preference_set",
                "Set a user preference (key/value). The prior value is auto-superseded.",
                {
                    "key": {"type": "string"},
                    "value": {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                ["key", "value"],
            ),
            tool(
                "memory_observe",
                "Write a short-lived session-scoped working-memory note (expires after ~7 days).",
                {"note": {"type": "string"}},
                ["note"],
            ),
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs: Any) -> str:
        if self._client is None:
            return "elephant memory is not initialized"
        try:
            return self._dispatch(tool_name, args)
        except ElephantError as err:
            return f"elephant error ({err.status}): {err}"
        except Exception as err:  # noqa: BLE001 — tool errors go back as text
            return f"elephant error: {err}"

    def _dispatch(self, tool_name: str, args: Dict[str, Any]) -> str:
        client = self._client
        assert client is not None
        agent_id = self._config.get("agent_id", "hermes")

        if tool_name == "memory_recall":
            data = client.recall(
                q=args["query"],
                agentId=agent_id,
                sessionId=self._session_id or None,
                projectId=self._config.get("project_id"),
                userId=self._config.get("user_id"),
                agentScope="boost",
                projectScope="boost" if self._config.get("project_id") else "none",
                userScope="boost" if self._config.get("user_id") else "none",
                **({"from": args["from"]} if args.get("from") else {}),
                **({"to": args["to"]} if args.get("to") else {}),
                minImportance=args.get("minImportance"),
                limit=args.get("limit") or 10,
                includePreferences=True,
                includeInsights=True,
                includeProcedures=True,
            )
            return _format_recall(data) or "No matches."

        if tool_name == "memory_save":
            saved = client.save_fact(
                content=args["fact"],
                category=args.get("category"),
                importance=args.get("importance"),
                entityNames=args.get("entities"),
                agentId=agent_id,
                sessionId=self._session_id or None,
                projectId=self._config.get("project_id"),
                userId=self._config.get("user_id"),
                actor=agent_id,
            )
            return f"Saved fact {saved.get('id')}"

        if tool_name == "memory_forget":
            fact_id = args.get("factId")
            if fact_id:
                if not UUID_RE.match(str(fact_id)):
                    return "factId must be a UUID."
                client.delete_fact(str(fact_id))
                return f"Soft-deleted fact {fact_id}. Audit history preserved."
            query = args.get("query")
            if not query:
                return "Provide factId or query."
            # Hard-filter to this agent's own facts: a fuzzy forget must never
            # land on (let alone delete) another agent's memory.
            data = client.recall(q=query, agentId=agent_id, agentScope="filter", kinds=["fact"], limit=5)
            facts = data.get("facts") or []
            if not facts:
                return "No matching facts."
            if len(facts) == 1:
                client.delete_fact(facts[0]["id"])
                return f"Soft-deleted the single match:\n{_format_fact(facts[0])}"
            listing = "\n".join(_format_fact(f) for f in facts)
            return f"Multiple matches — call memory_forget with the factId to delete:\n{listing}"

        if tool_name == "memory_timeline":
            entity_id = None
            if args.get("entity"):
                found = client.search_entities(args["entity"], 1).get("entities") or []
                if not found:
                    return f"No entity found matching \"{args['entity']}\"."
                entity_id = found[0]["id"]
            data = client.timeline(
                at=args["at"],
                entityId=entity_id,
                preferenceKey=args.get("preferenceKey"),
            )
            lines = [f"Beliefs valid at {data.get('at')}:"]
            if data.get("preference"):
                lines.append(f"Preference {args.get('preferenceKey')}: {data['preference']['value']}")
            facts = data.get("facts") or []
            lines.append("\n".join(_format_fact(f) for f in facts) if facts else "(no facts)")
            return "\n".join(lines)

        if tool_name == "memory_entity":
            if args.get("id"):
                if not UUID_RE.match(str(args["id"])):
                    return "id must be a UUID."
                data = client.get_entity(str(args["id"]))
                entity = data.get("entity") or {}
                lines = [f"{entity.get('name')} ({entity.get('type')}) [{entity.get('id')}]"]
                lines.extend(_format_fact(f) for f in data.get("facts") or [])
                return "\n".join(lines)
            if not args.get("name"):
                return "Provide name or id."
            entities = client.search_entities(args["name"], 10).get("entities") or []
            if not entities:
                return f"No entities matching \"{args['name']}\"."
            return "\n".join(f"- {e['name']} ({e['type']}) [{e['id']}]" for e in entities)

        if tool_name == "memory_preference_get":
            try:
                pref = client.get_preference(args["key"])
                return f"{pref['key']}: {pref['value']} (confidence {pref.get('confidence')})"
            except ElephantError as err:
                if err.status == 404:
                    return f"Preference \"{args['key']}\" is not set."
                raise

        if tool_name == "memory_preference_set":
            pref = client.put_preference(
                args["key"], args["value"], confidence=args.get("confidence"), actor=agent_id
            )
            return f"Set {args['key']} = \"{args['value']}\" (validFrom {pref.get('validFrom')})"

        if tool_name == "memory_observe":
            obs = client.write_observation(
                agent_id=agent_id,
                session_id=self._session_id or "hermes:default",
                content=args["note"],
            )
            return f"Observed (expires {obs.get('expiresAt')})."

        return f"Unknown tool: {tool_name}"

    # ─ setup wizard ─────────────────────────────────────────────────────────

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "token",
                "description": "Elephant bearer token (MEMORY_SERVICE_TOKEN of the service, min 8 chars)",
                "secret": True,
                "required": True,
                "env_var": TOKEN_ENV,
            },
            {
                "key": "url",
                "description": "Elephant service URL",
                "required": False,
                "default": DEFAULT_URL,
            },
            {
                "key": "agent_id",
                "description": "Agent id stamped on writes and boosted at recall",
                "required": False,
                "default": "hermes",
            },
            {"key": "project_id", "description": "Optional project scope", "required": False},
            {"key": "user_id", "description": "Optional user scope", "required": False},
            {
                "key": "auto_recall_limit",
                "description": "Max items injected per prefetch",
                "required": False,
                "default": "8",
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        non_secret = {k: v for k, v in values.items() if k != "token" and v not in (None, "")}
        path = os.path.join(hermes_home, CONFIG_FILE)
        os.makedirs(hermes_home, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(non_secret, fh, indent=2)
            fh.write("\n")

    def backup_paths(self) -> List[str]:
        return []  # memory lives in the external elephant service


def _transcript_of(messages: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for message in messages or []:
        role = str(message.get("role", "unknown")).upper()
        content = message.get("content")
        if isinstance(content, list):
            content = "\n".join(
                str(block.get("text", "")) for block in content if isinstance(block, dict)
            )
        if not isinstance(content, str) or not content.strip():
            continue
        lines.append(f"{role}: {content}")
    return "\n\n".join(lines)


def register(ctx) -> None:  # noqa: ANN001 — ctx type is supplied by hermes
    """Register elephant as a memory provider plugin."""
    ctx.register_memory_provider(ElephantMemoryProvider())
