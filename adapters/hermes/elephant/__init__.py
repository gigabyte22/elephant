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
from copy import deepcopy
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

_NO_PROJECT = (
    "Research is always project-scoped, but no project_id is configured. "
    "Set project_id in elephant.json (or use memory_knowledge_save instead)."
)


def _bad_uuid(value: Any, field: str) -> Optional[str]:
    """Reject a malformed id before it reaches the wire — mirrors the guard on
    memory_forget so a path-shaped argument can never be sent."""
    if not value or not UUID_RE.match(str(value)):
        return f"{field} must be a UUID."
    return None


def _present(args: Dict[str, Any], keys: tuple) -> Dict[str, Any]:
    """The supplied subset of `keys`. Update endpoints reject a body with no
    real fields, so omitted keys must not be sent as nulls."""
    return {key: args[key] for key in keys if args.get(key) is not None}


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


def _tool(
    name: str,
    description: str,
    properties: Dict[str, Any],
    required: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """One OpenAI-format function schema. `properties` is deep-copied so the
    shared fragments below stay private to each schema — callers get a fully
    independent structure, exactly as when every schema was an inline literal."""
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": deepcopy(properties),
                "required": list(required or []),
            },
        },
    }


# Property fragments shared across tool schemas, to keep the 34 definitions
# below readable. `_tool` copies them, so they are never aliased into a result.
_UNIT = {"type": "number", "minimum": 0, "maximum": 1}
_LIST_LIMIT = {"type": "number", "minimum": 1, "maximum": 200}
_TAGS = {"type": "array", "items": {"type": "string"}}
_ID_ONLY = {"id": {"type": "string"}}
_ID_AND_REASON = {"id": {"type": "string"}, "reason": {"type": "string"}}
# Knowledge documents and research records take the same update body.
_DOC_UPDATE_PROPS = {
    "id": {"type": "string"},
    "title": {"type": "string"},
    "content": {"type": "string"},
    "summary": {"type": "string"},
    "tags": _TAGS,
    "reason": {"type": "string"},
}


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
        # Belt and braces: _recall_block already swallows transport and format
        # errors, but prefetch is on the turn's critical path — nothing it does
        # may raise into the agent loop.
        try:
            with self._prefetch_lock:
                cached = self._prefetch_cache.pop(query, None)
            if cached is not None:
                return cached
            return self._recall_block(query, session_id)
        except Exception as err:  # noqa: BLE001 — recall must never block the turn
            logger.debug("elephant prefetch failed: %s", err)
            return ""

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
                includeKnowledge=True,
                includeResearch=True,
                includeIntentions=True,
            )
            rendered = _format_recall(data)
        except Exception as err:  # noqa: BLE001 — recall must never block the turn
            logger.debug("elephant prefetch failed: %s", err)
            return ""
        return f"[elephant memory]\n{rendered}" if rendered else ""

    # ─ tools ────────────────────────────────────────────────────────────────

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            _tool(
                "memory_recall",
                "Recall facts, preferences, insights, and procedures from long-term memory. Supports temporal and importance filters.",
                {
                    "query": {"type": "string", "description": "Natural language query"},
                    "from": {"type": "string", "description": "ISO date lower bound"},
                    "to": {"type": "string", "description": "ISO date upper bound"},
                    "minImportance": _UNIT,
                    "limit": {"type": "number", "minimum": 1, "maximum": 50},
                },
                ["query"],
            ),
            _tool(
                "memory_save",
                "Save a durable fact to long-term memory (one sentence is best).",
                {
                    "fact": {"type": "string"},
                    "category": {"type": "string"},
                    "importance": _UNIT,
                    "entities": _TAGS,
                },
                ["fact"],
            ),
            _tool(
                "memory_forget",
                "Soft-delete a fact by id (preferred) or query. A fuzzy query never bulk-deletes.",
                {
                    "factId": {"type": "string", "description": "Exact fact UUID (preferred)"},
                    "query": {"type": "string"},
                },
            ),
            _tool(
                "memory_timeline",
                "Bi-temporal query: facts (optionally about one entity) or a preference as valid at a given instant.",
                {
                    "at": {"type": "string", "description": "ISO timestamp"},
                    "entity": {"type": "string"},
                    "preferenceKey": {"type": "string"},
                },
                ["at"],
            ),
            _tool(
                "memory_entity",
                "Fuzzy-search entities by name, or fetch one with its fact subgraph by id.",
                {"name": {"type": "string"}, "id": {"type": "string"}},
            ),
            _tool(
                "memory_preference_get",
                "Read a user preference by key.",
                {"key": {"type": "string"}},
                ["key"],
            ),
            _tool(
                "memory_preference_set",
                "Set a user preference (key/value). The prior value is auto-superseded.",
                {
                    "key": {"type": "string"},
                    "value": {"type": "string"},
                    "confidence": _UNIT,
                },
                ["key", "value"],
            ),
            _tool(
                "memory_observe",
                "Write a short-lived session-scoped working-memory note (expires after ~7 days).",
                {"note": {"type": "string"}},
                ["note"],
            ),
            # ── knowledge documents ──
            _tool(
                "memory_knowledge_save",
                "Store a durable reference document (docs, specs, runbooks). Chunked and embedded for recall.",
                {
                    "title": {"type": "string"},
                    "source": {"type": "string", "description": "Where it came from, e.g. 'handbook'"},
                    "content": {"type": "string", "description": "Full document text"},
                    "sourceUri": {"type": "string", "description": "Absolute URL, if any"},
                    "summary": {"type": "string"},
                    "tags": _TAGS,
                },
                ["title", "source", "content"],
            ),
            _tool(
                "memory_knowledge_get",
                "Fetch one knowledge document by id, with its full content.",
                _ID_ONLY,
                ["id"],
            ),
            _tool(
                "memory_knowledge_list",
                "List knowledge documents in the current scope.",
                {"limit": _LIST_LIMIT},
            ),
            _tool(
                "memory_knowledge_update",
                "Update a knowledge document. Prior revision is archived automatically.",
                _DOC_UPDATE_PROPS,
                ["id"],
            ),
            _tool(
                "memory_knowledge_delete",
                "Soft-delete a knowledge document. Set purge to also drop its embedded chunks.",
                {**_ID_ONLY, "purge": {"type": "boolean"}},
                ["id"],
            ),
            # ── research ──
            _tool(
                "memory_research_save",
                "Store a research write-up. Always project-scoped.",
                {
                    "title": {"type": "string"},
                    "source": {"type": "string"},
                    "content": {"type": "string"},
                    "sourceUri": {"type": "string"},
                    "summary": {"type": "string"},
                    "tags": _TAGS,
                },
                ["title", "source", "content"],
            ),
            _tool(
                "memory_research_get",
                "Fetch one research record by id, with its full content.",
                _ID_ONLY,
                ["id"],
            ),
            _tool(
                "memory_research_list",
                "List research records for the configured project.",
                {"limit": _LIST_LIMIT},
            ),
            _tool(
                "memory_research_update",
                "Update a research record. Prior revision is archived automatically.",
                _DOC_UPDATE_PROPS,
                ["id"],
            ),
            _tool(
                "memory_research_delete",
                "Soft-delete a research record.",
                _ID_ONLY,
                ["id"],
            ),
            # ── procedures ──
            _tool(
                "memory_procedure_save",
                "Save a reusable procedure (how to do something, and when it applies).",
                {
                    "name": {"type": "string"},
                    "content": {"type": "string", "description": "The steps"},
                    "whenToUse": {"type": "string", "description": "Trigger conditions"},
                },
                ["name", "content", "whenToUse"],
            ),
            _tool(
                "memory_procedure_get",
                "Fetch a procedure by id, or by exact name.",
                {"id": {"type": "string"}, "name": {"type": "string"}},
            ),
            _tool(
                "memory_procedure_list",
                "List procedures in the current scope.",
                {"limit": _LIST_LIMIT},
            ),
            _tool(
                "memory_procedure_update",
                "Update a procedure's steps or trigger conditions. Bumps its version.",
                {
                    "id": {"type": "string"},
                    "content": {"type": "string"},
                    "whenToUse": {"type": "string"},
                    "reason": {"type": "string"},
                },
                ["id"],
            ),
            _tool(
                "memory_procedure_delete",
                "Soft-delete a procedure.",
                _ID_ONLY,
                ["id"],
            ),
            # ── intentions ──
            _tool(
                "memory_intention_create",
                "Record a commitment to do something later (a reminder or follow-up).",
                {
                    "content": {"type": "string"},
                    "dueAt": {"type": "string", "description": "ISO timestamp"},
                    "triggerHint": {"type": "string", "description": "Situational trigger, if not time-based"},
                    "recurring": {"type": "boolean"},
                    "schedule": {"type": "string", "description": "Cron-ish schedule for recurring intentions"},
                    "importance": _UNIT,
                },
                ["content"],
            ),
            _tool(
                "memory_intention_list",
                "List intentions, optionally filtered by status.",
                {
                    "status": {
                        "type": "string",
                        "enum": ["pending", "completed", "cancelled", "expired"],
                    },
                    "limit": _LIST_LIMIT,
                },
            ),
            _tool(
                "memory_intention_due",
                "List open intentions due before a timestamp (defaults to now).",
                {
                    "before": {"type": "string", "description": "ISO timestamp"},
                    "limit": _LIST_LIMIT,
                },
            ),
            _tool(
                "memory_intention_complete",
                "Mark an intention as done.",
                _ID_AND_REASON,
                ["id"],
            ),
            _tool(
                "memory_intention_cancel",
                "Cancel an intention that is no longer wanted.",
                _ID_AND_REASON,
                ["id"],
            ),
            _tool(
                "memory_intention_fired",
                "Record one firing of a recurring intention (bumps its fire count).",
                _ID_AND_REASON,
                ["id"],
            ),
            # ── working state ──
            _tool(
                "memory_state_set",
                "Set a scratchpad key for this agent/session. Ephemeral — use memory_save for durable facts.",
                {
                    "key": {"type": "string"},
                    "value": {"type": "string"},
                    "ttlSec": {"type": "number", "minimum": 1},
                },
                ["key", "value"],
            ),
            _tool(
                "memory_state_get",
                "Read a scratchpad key for this agent/session.",
                {"key": {"type": "string"}},
                ["key"],
            ),
            _tool(
                "memory_state_list",
                "List scratchpad keys for this agent/session.",
                {"prefix": {"type": "string"}},
            ),
            _tool(
                "memory_state_delete",
                "Delete a scratchpad key for this agent/session.",
                {"key": {"type": "string"}},
                ["key"],
            ),
            # ── audit ──
            _tool(
                "memory_audit",
                "Show the revision and audit history of one memory item by id.",
                {
                    "targetId": {"type": "string"},
                    "limit": {"type": "number", "minimum": 1, "maximum": 500},
                },
                ["targetId"],
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
                # Must match _recall_block: prefetch and the tool call ranking
                # the same query differently is a correctness bug, not a nuance.
                sessionScope="boost",
                projectScope="boost" if self._config.get("project_id") else "none",
                userScope="boost" if self._config.get("user_id") else "none",
                **({"from": args["from"]} if args.get("from") else {}),
                **({"to": args["to"]} if args.get("to") else {}),
                minImportance=args.get("minImportance"),
                limit=args.get("limit") or 10,
                includePreferences=True,
                includeInsights=True,
                includeProcedures=True,
                includeKnowledge=True,
                includeResearch=True,
                includeIntentions=True,
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

        # ── knowledge documents ──

        if tool_name == "memory_knowledge_save":
            doc = client.ingest_knowledge(
                title=args["title"],
                source=args["source"],
                content=args["content"],
                scope=self._doc_scope(),
                actor=agent_id,
                **_present(args, ("sourceUri", "summary", "tags")),
            )
            return f"Saved knowledge document {doc.get('id')} ({doc.get('title')})"

        if tool_name == "memory_knowledge_get":
            bad = _bad_uuid(args.get("id"), "id")
            if bad:
                return bad
            doc = client.get_knowledge(str(args["id"]))
            return _detail(_format_document(doc), doc)

        if tool_name == "memory_knowledge_list":
            docs = client.list_knowledge(**self._doc_scope(), limit=args.get("limit") or 20)
            if not docs:
                return "No knowledge documents."
            return "\n".join(_format_document(d) for d in docs)

        if tool_name == "memory_knowledge_update":
            bad = _bad_uuid(args.get("id"), "id")
            if bad:
                return bad
            fields = _present(args, ("title", "content", "summary", "tags"))
            if not fields:
                return "Provide at least one field to update."
            doc = client.update_knowledge(
                str(args["id"]), actor=agent_id, **fields, **_present(args, ("reason",))
            )
            return f"Updated knowledge document {doc.get('id')} ({doc.get('title')})"

        if tool_name == "memory_knowledge_delete":
            bad = _bad_uuid(args.get("id"), "id")
            if bad:
                return bad
            purge = bool(args.get("purge"))
            result = client.delete_knowledge(str(args["id"]), purge=purge)
            detail = f", purged {result.get('chunksDeleted')} chunks" if purge else ""
            return f"Soft-deleted knowledge document {args['id']}{detail}. Audit history preserved."

        # ── research ──

        if tool_name == "memory_research_save":
            project_id = self._config.get("project_id")
            if not project_id:
                return _NO_PROJECT
            record = client.create_research(
                title=args["title"],
                source=args["source"],
                content=args["content"],
                projectId=project_id,
                actor=agent_id,
                **({"userId": self._config["user_id"]} if self._config.get("user_id") else {}),
                **_present(args, ("sourceUri", "summary", "tags")),
            )
            return f"Saved research {record.get('id')} ({record.get('title')})"

        if tool_name == "memory_research_get":
            bad = _bad_uuid(args.get("id"), "id")
            if bad:
                return bad
            record = client.get_research(str(args["id"]), self._config.get("project_id"))
            return _detail(_format_document(record), record)

        if tool_name == "memory_research_list":
            project_id = self._config.get("project_id")
            if not project_id:
                return _NO_PROJECT
            records = client.list_research(
                project_id,
                userId=self._config.get("user_id"),
                limit=args.get("limit") or 20,
            )
            if not records:
                return "No research records."
            return "\n".join(_format_document(r) for r in records)

        if tool_name == "memory_research_update":
            bad = _bad_uuid(args.get("id"), "id")
            if bad:
                return bad
            fields = _present(args, ("title", "content", "summary", "tags"))
            if not fields:
                return "Provide at least one field to update."
            record = client.update_research(
                str(args["id"]),
                self._config.get("project_id"),
                actor=agent_id,
                **fields,
                **_present(args, ("reason",)),
            )
            return f"Updated research {record.get('id')} ({record.get('title')})"

        if tool_name == "memory_research_delete":
            bad = _bad_uuid(args.get("id"), "id")
            if bad:
                return bad
            client.delete_research(str(args["id"]))
            return f"Soft-deleted research {args['id']}. Audit history preserved."

        # ── procedures ──

        if tool_name == "memory_procedure_save":
            proc = client.create_procedure(
                name=args["name"],
                content=args["content"],
                whenToUse=args["whenToUse"],
                scope=self._doc_scope(),
                actor=agent_id,
            )
            return f"Saved procedure {proc.get('id')} ({proc.get('name')} v{proc.get('version')})"

        if tool_name == "memory_procedure_get":
            if args.get("id"):
                bad = _bad_uuid(args.get("id"), "id")
                if bad:
                    return bad
                proc = client.get_procedure(str(args["id"]))
                return _detail(_format_procedure(proc), proc)
            if not args.get("name"):
                return "Provide id or name."
            found = client.get_procedure_by_name(str(args["name"]), self._config.get("project_id"))
            if not found:
                return f"No procedure named \"{args['name']}\"."
            return _detail(_format_procedure(found[0]), found[0])

        if tool_name == "memory_procedure_list":
            procs = client.list_procedures(**self._doc_scope(), limit=args.get("limit") or 20)
            if not procs:
                return "No procedures."
            return "\n".join(_format_procedure(p) for p in procs)

        if tool_name == "memory_procedure_update":
            bad = _bad_uuid(args.get("id"), "id")
            if bad:
                return bad
            fields = _present(args, ("content", "whenToUse"))
            if not fields:
                return "Provide at least one field to update."
            proc = client.update_procedure(
                str(args["id"]), actor=agent_id, **fields, **_present(args, ("reason",))
            )
            return f"Updated procedure {proc.get('id')} (now v{proc.get('version')})"

        if tool_name == "memory_procedure_delete":
            bad = _bad_uuid(args.get("id"), "id")
            if bad:
                return bad
            client.delete_procedure(str(args["id"]))
            return f"Soft-deleted procedure {args['id']}. Audit history preserved."

        # ── intentions ──

        if tool_name == "memory_intention_create":
            intention = client.create_intention(
                content=args["content"],
                scope=self._intention_scope(include_session=True),
                actor=agent_id,
                **_present(
                    args, ("dueAt", "triggerHint", "recurring", "schedule", "importance")
                ),
            )
            return f"Recorded intention {intention.get('id')}."

        if tool_name == "memory_intention_list":
            intentions = client.list_intentions(
                **self._intention_scope(),
                status=args.get("status"),
                limit=args.get("limit") or 20,
            )
            if not intentions:
                return "No intentions."
            return "\n".join(_format_intention(i) for i in intentions)

        if tool_name == "memory_intention_due":
            intentions = client.list_due_intentions(
                **self._intention_scope(),
                before=args.get("before"),
                limit=args.get("limit") or 20,
            )
            if not intentions:
                return "Nothing due."
            return "\n".join(_format_intention(i) for i in intentions)

        if tool_name in {
            "memory_intention_complete",
            "memory_intention_cancel",
            "memory_intention_fired",
        }:
            bad = _bad_uuid(args.get("id"), "id")
            if bad:
                return bad
            call, verb = {
                "memory_intention_complete": (client.complete_intention, "Completed"),
                "memory_intention_cancel": (client.cancel_intention, "Cancelled"),
                "memory_intention_fired": (client.mark_intention_fired, "Fired"),
            }[tool_name]
            intention = call(str(args["id"]), actor=agent_id, **_present(args, ("reason",)))
            return f"{verb} intention {intention.get('id')} (status {intention.get('status')})."

        # ── working state ──

        if tool_name == "memory_state_set":
            client.set_state(
                self._state_scope(),
                args["key"],
                args["value"],
                ttl_sec=args.get("ttlSec"),
            )
            return f"Set state {args['key']}."

        if tool_name == "memory_state_get":
            try:
                entry = client.get_state(args["key"], **self._state_scope())
            except ElephantError as err:
                if err.status == 404:
                    return f"State key \"{args['key']}\" is not set."
                raise
            return f"{entry.get('key')} = {json.dumps(entry.get('value'))} (expires {entry.get('expiresAt')})"

        if tool_name == "memory_state_list":
            entries = client.list_state(**self._state_scope(), prefix=args.get("prefix"))
            if not entries:
                return "No state keys."
            return "\n".join(
                f"- {e.get('key')} = {json.dumps(e.get('value'))}" for e in entries
            )

        if tool_name == "memory_state_delete":
            client.delete_state(args["key"], **self._state_scope())
            return f"Deleted state {args['key']}."

        # ── audit ──

        if tool_name == "memory_audit":
            bad = _bad_uuid(args.get("targetId"), "targetId")
            if bad:
                return bad
            data = client.audit(str(args["targetId"]), args.get("limit") or 50)
            events = data.get("events") or []
            revisions = data.get("revisions") or []
            if not events and not revisions:
                return f"No audit history for {args['targetId']}."
            lines = [f"Audit for {args['targetId']}:"]
            for event in events:
                lines.append(
                    f"- {event.get('at')} {event.get('kind')} by {event.get('actor') or 'unknown'}"
                )
            for revision in revisions:
                lines.append(
                    f"- revision {revision.get('id')} archived {revision.get('archivedAt')}"
                    f" ({revision.get('reason')})"
                )
            return "\n".join(lines)

        return f"Unknown tool: {tool_name}"

    # ─ scope helpers ────────────────────────────────────────────────────────

    def _doc_scope(self) -> Dict[str, Any]:
        """Knowledge/procedure scope: only the axes that are actually configured."""
        return _scope_of(self._config)

    def _intention_scope(self, *, include_session: bool = False) -> Dict[str, Any]:
        """Intentions outlive the session that created them, and every axis
        supplied to the list/due queries becomes a hard filter — so sessionId is
        stamped on create for provenance but left off reads, which would
        otherwise hide commitments made in an earlier session."""
        scope = self._doc_scope()
        scope["agentId"] = self._config.get("agent_id", "hermes")
        if include_session and self._session_id:
            scope["sessionId"] = self._session_id
        return scope

    def _state_scope(self) -> Dict[str, Any]:
        scope = self._doc_scope()
        scope["agentId"] = self._config.get("agent_id", "hermes")
        scope["sessionId"] = self._session_id or "hermes:default"
        return scope

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
