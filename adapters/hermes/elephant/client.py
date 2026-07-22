"""Stdlib-only HTTP client for the elephant memory service.

Bearer auth, ``{ok, data} / {ok, error}`` envelope unwrapping, small retry
budget on 5xx and network errors. Kept dependency-free so the hermes plugin
adds no pip requirements.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


class ElephantError(Exception):
    def __init__(self, status: int, message: str, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def _seg(value: str) -> str:
    """Encode a caller-supplied id as one path segment — an id containing
    ``/`` or ``..`` must not be able to reroute the request."""
    return urllib.parse.quote(str(value), safe="")


def _drop_none(fields: Dict[str, Any]) -> Dict[str, Any]:
    """Omit unset fields from a request body. No field on the fact body is
    nullable server-side — ``z.optional()`` accepts a missing key but rejects an
    explicit ``null``, so an unset category/projectId would 400 the whole write.
    Only use this where ``null`` carries no meaning of its own (it *does* on
    e.g. ``expiresAt``/``dueAt``, where it means "clear this")."""
    return {key: value for key, value in fields.items() if value is not None}


def _qs(params: Dict[str, Any]) -> str:
    clean: Dict[str, str] = {}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, bool):
            clean[key] = "true" if value else "false"
        elif isinstance(value, (list, tuple)):
            clean[key] = ",".join(str(v) for v in value)
        else:
            clean[key] = str(value)
    return urllib.parse.urlencode(clean)


class ElephantClient:
    def __init__(
        self,
        url: str,
        token: str,
        *,
        timeout_sec: float = 15.0,
        retries: int = 2,
    ) -> None:
        self.url = url.rstrip("/")
        self.token = token
        self.timeout_sec = timeout_sec
        self.retries = retries

    # ─ plumbing ─────────────────────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        *,
        timeout_sec: Optional[float] = None,
        retries: Optional[int] = None,
    ) -> Any:
        attempts = (self.retries if retries is None else retries) + 1
        last_err: Optional[Exception] = None
        for attempt in range(attempts):
            data = json.dumps(body).encode("utf-8") if body is not None else None
            req = urllib.request.Request(
                f"{self.url}{path}",
                data=data,
                method=method,
                headers={
                    "authorization": f"Bearer {self.token}",
                    **({"content-type": "application/json"} if data is not None else {}),
                },
            )
            try:
                with urllib.request.urlopen(
                    req, timeout=timeout_sec or self.timeout_sec
                ) as res:
                    payload = json.loads(res.read().decode("utf-8"))
            except urllib.error.HTTPError as err:
                status = err.code
                try:
                    payload = json.loads(err.read().decode("utf-8"))
                except Exception:
                    payload = None
                message = (payload or {}).get("error") or f"{method} {path} -> {status}"
                last_err = ElephantError(status, message, payload)
                if status >= 500 and attempt + 1 < attempts:
                    time.sleep(0.2 * (2**attempt))
                    continue
                raise last_err from err
            except (urllib.error.URLError, TimeoutError, OSError) as err:
                last_err = err
                if attempt + 1 < attempts:
                    time.sleep(0.2 * (2**attempt))
                    continue
                raise
            if not isinstance(payload, dict) or not payload.get("ok"):
                message = (payload or {}).get("error") if isinstance(payload, dict) else None
                raise ElephantError(200, message or f"{method} {path} -> malformed envelope", payload)
            return payload.get("data")
        raise last_err if last_err else RuntimeError("unreachable")

    # ─ endpoints ────────────────────────────────────────────────────────────

    def health(self, *, timeout_sec: float = 3.0) -> Dict[str, Any]:
        return self._request("GET", "/health", timeout_sec=timeout_sec, retries=0)

    def save_fact(self, **fields: Any) -> Dict[str, Any]:
        return self._request("POST", "/facts", _drop_none(fields))

    def save_facts(self, facts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return self._request("POST", "/facts/batch", {"facts": [_drop_none(f) for f in facts]})

    def supersede_fact(self, old_id: str, new_fact_id: str, reason: str) -> Dict[str, Any]:
        return self._request(
            "POST",
            f"/facts/{_seg(old_id)}/supersede",
            {"newFactId": new_fact_id, "reason": reason},
        )

    def delete_fact(self, fact_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/facts/{_seg(fact_id)}")

    def recall(self, **params: Any) -> Dict[str, Any]:
        return self._request("GET", f"/recall?{_qs(params)}")

    def timeline(self, **params: Any) -> Dict[str, Any]:
        return self._request("GET", f"/timeline?{_qs(params)}")

    def search_entities(self, name: str, limit: int = 10) -> Dict[str, Any]:
        return self._request("GET", f"/entities?{_qs({'name': name, 'limit': limit})}")

    def get_entity(self, entity_id: str, *, include_superseded: bool = False) -> Dict[str, Any]:
        query = _qs({"includeSuperseded": include_superseded})
        return self._request("GET", f"/entities/{_seg(entity_id)}?{query}")

    def list_preferences(self) -> Dict[str, Any]:
        return self._request("GET", "/preferences")

    def get_preference(self, key: str) -> Dict[str, Any]:
        return self._request("GET", f"/preferences/{_seg(key)}")

    def put_preference(
        self, key: str, value: str, *, confidence: Optional[float] = None, actor: Optional[str] = None
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"value": value}
        if confidence is not None:
            body["confidence"] = confidence
        if actor is not None:
            body["actor"] = actor
        return self._request("PUT", f"/preferences/{_seg(key)}", body)

    def write_observation(self, *, agent_id: str, session_id: str, content: str) -> Dict[str, Any]:
        return self._request(
            "POST",
            "/observations",
            {"agentId": agent_id, "sessionId": session_id, "content": content},
        )

    def list_observations(self, session_id: str, limit: int = 100) -> Dict[str, Any]:
        return self._request("GET", f"/observations?{_qs({'sessionId': session_id, 'limit': limit})}")

    def ingest_episode(self, **fields: Any) -> Dict[str, Any]:
        return self._request("POST", "/episodes", fields)

    def trigger_dream(self) -> Dict[str, Any]:
        return self._request("POST", "/dream", {})

    def dream_status(self, job_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/dream/{_seg(job_id)}")

    # ─ knowledge documents ──────────────────────────────────────────────────

    def ingest_knowledge(self, **fields: Any) -> Dict[str, Any]:
        return self._request("POST", "/knowledge/documents", fields)

    def get_knowledge(self, doc_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/knowledge/documents/{_seg(doc_id)}")

    def list_knowledge(self, **params: Any) -> List[Dict[str, Any]]:
        return self._request("GET", f"/knowledge/documents?{_qs(params)}")

    def update_knowledge(self, doc_id: str, **fields: Any) -> Dict[str, Any]:
        return self._request("PUT", f"/knowledge/documents/{_seg(doc_id)}", fields)

    def delete_knowledge(self, doc_id: str, purge: bool = False) -> Dict[str, Any]:
        # `purge` is a literal 'true'/'false' string enum server-side, not the
        # permissive bool parsing the other query flags use — send it verbatim.
        query = _qs({"purge": "true" if purge else "false"})
        return self._request("DELETE", f"/knowledge/documents/{_seg(doc_id)}?{query}")

    # ─ research ─────────────────────────────────────────────────────────────

    def create_research(self, **fields: Any) -> Dict[str, Any]:
        return self._request("POST", "/research", fields)

    def get_research(self, research_id: str, project_id: Optional[str] = None) -> Dict[str, Any]:
        return self._request("GET", f"/research/{_seg(research_id)}?{_qs({'projectId': project_id})}")

    def list_research(self, project_id: str, **params: Any) -> List[Dict[str, Any]]:
        return self._request("GET", f"/research?{_qs({'projectId': project_id, **params})}")

    def update_research(
        self, research_id: str, project_id: Optional[str] = None, **fields: Any
    ) -> Dict[str, Any]:
        query = _qs({"projectId": project_id})
        return self._request("PUT", f"/research/{_seg(research_id)}?{query}", fields)

    def delete_research(self, research_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/research/{_seg(research_id)}")

    # ─ procedures ───────────────────────────────────────────────────────────

    def create_procedure(self, **fields: Any) -> Dict[str, Any]:
        return self._request("POST", "/procedures", fields)

    def get_procedure(self, procedure_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/procedures/{_seg(procedure_id)}")

    def get_procedure_by_name(self, name: str, project_id: Optional[str] = None) -> List[Dict[str, Any]]:
        return self._request("GET", f"/procedures?{_qs({'name': name, 'projectId': project_id})}")

    def list_procedures(self, **params: Any) -> List[Dict[str, Any]]:
        return self._request("GET", f"/procedures?{_qs(params)}")

    def update_procedure(self, procedure_id: str, **fields: Any) -> Dict[str, Any]:
        return self._request("PUT", f"/procedures/{_seg(procedure_id)}", fields)

    def delete_procedure(self, procedure_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/procedures/{_seg(procedure_id)}")

    # ─ intentions ───────────────────────────────────────────────────────────

    def create_intention(self, **fields: Any) -> Dict[str, Any]:
        return self._request("POST", "/intentions", fields)

    def get_intention(self, intention_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/intentions/{_seg(intention_id)}")

    def list_intentions(self, **params: Any) -> List[Dict[str, Any]]:
        return self._request("GET", f"/intentions?{_qs(params)}")

    def list_due_intentions(self, **params: Any) -> List[Dict[str, Any]]:
        return self._request("GET", f"/intentions/due?{_qs(params)}")

    def complete_intention(self, intention_id: str, **fields: Any) -> Dict[str, Any]:
        return self._request("POST", f"/intentions/{_seg(intention_id)}/complete", fields)

    def cancel_intention(self, intention_id: str, **fields: Any) -> Dict[str, Any]:
        return self._request("POST", f"/intentions/{_seg(intention_id)}/cancel", fields)

    def mark_intention_fired(self, intention_id: str, **fields: Any) -> Dict[str, Any]:
        return self._request("POST", f"/intentions/{_seg(intention_id)}/fired", fields)

    # ─ working state ────────────────────────────────────────────────────────

    def set_state(
        self, scope: Dict[str, Any], key: str, value: Any, ttl_sec: Optional[int] = None
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"scope": scope, "key": key, "value": value}
        if ttl_sec is not None:
            body["ttlSec"] = ttl_sec
        return self._request("POST", "/state", body)

    def get_state(self, key: str, **scope: Any) -> Dict[str, Any]:
        return self._request("GET", f"/state/{_seg(key)}?{_qs(scope)}")

    def list_state(self, **scope: Any) -> List[Dict[str, Any]]:
        return self._request("GET", f"/state?{_qs(scope)}")

    def delete_state(self, key: str, **scope: Any) -> Dict[str, Any]:
        return self._request("DELETE", f"/state/{_seg(key)}?{_qs(scope)}")

    # ─ audit ────────────────────────────────────────────────────────────────

    def audit(self, target_id: str, limit: int = 100) -> Dict[str, Any]:
        return self._request("GET", f"/audit/{_seg(target_id)}?{_qs({'limit': limit})}")

    def audit_list(self, **params: Any) -> List[Dict[str, Any]]:
        return self._request("GET", f"/audit?{_qs(params)}")


__all__: List[str] = ["ElephantClient", "ElephantError"]
