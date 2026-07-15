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
        return self._request("POST", "/facts", fields)

    def delete_fact(self, fact_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/facts/{_seg(fact_id)}")

    def recall(self, **params: Any) -> Dict[str, Any]:
        return self._request("GET", f"/recall?{_qs(params)}")

    def timeline(self, **params: Any) -> Dict[str, Any]:
        return self._request("GET", f"/timeline?{_qs(params)}")

    def search_entities(self, name: str, limit: int = 10) -> Dict[str, Any]:
        return self._request("GET", f"/entities?{_qs({'name': name, 'limit': limit})}")

    def get_entity(self, entity_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/entities/{_seg(entity_id)}?includeSuperseded=false")

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

    def ingest_episode(self, **fields: Any) -> Dict[str, Any]:
        return self._request("POST", "/episodes", fields)

    def trigger_dream(self) -> Dict[str, Any]:
        return self._request("POST", "/dream", {})


__all__: List[str] = ["ElephantClient", "ElephantError"]
