"""Unit tests for the elephant hermes-agent memory provider.

urllib is monkeypatched so no elephant service is needed; requests are
recorded and served from a canned response map.
"""

from __future__ import annotations

import io
import json
import threading
import urllib.parse
import urllib.request

import pytest

import elephant
from elephant import ElephantMemoryProvider, register
from elephant.client import ElephantClient, ElephantError

FACT_ID = "3f0e8f6a-58a2-4bfb-9d6e-0f6f4a1c2b3d"


class FakeHttp:
    """Records requests; serves responses by (method, path-prefix)."""

    def __init__(self):
        self.requests = []
        self.responses = {}
        self.posted = threading.Event()

    def respond(self, method, path_prefix, data):
        self.responses[(method, path_prefix)] = data

    def __call__(self, req, timeout=None):
        parsed = urllib.parse.urlparse(req.full_url)
        body = json.loads(req.data.decode()) if req.data else None
        self.requests.append(
            {"method": req.get_method(), "path": parsed.path, "query": dict(urllib.parse.parse_qsl(parsed.query)), "body": body}
        )
        self.posted.set()
        for (method, prefix), data in self.responses.items():
            if req.get_method() == method and parsed.path.startswith(prefix):
                return io.BytesIO(json.dumps({"ok": True, "data": data}).encode())
        return io.BytesIO(json.dumps({"ok": True, "data": {}}).encode())


class _Closing(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


@pytest.fixture
def fake_http(monkeypatch):
    fake = FakeHttp()

    def urlopen(req, timeout=None):
        raw = fake(req, timeout=timeout)
        return _Closing(raw.read())

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return fake


@pytest.fixture
def provider(fake_http, monkeypatch, tmp_path):
    monkeypatch.setenv(elephant.TOKEN_ENV, "tok-12345678")
    fake_http.respond("GET", "/health", {"neo4j": True})
    p = ElephantMemoryProvider()
    p.initialize("session-1", hermes_home=str(tmp_path))
    yield p
    p.shutdown()


def test_register_wires_the_provider():
    captured = {}

    class Ctx:
        def register_memory_provider(self, instance):
            captured["provider"] = instance

    register(Ctx())
    assert isinstance(captured["provider"], ElephantMemoryProvider)
    assert captured["provider"].name == "elephant"


def test_tool_schemas_are_openai_format():
    schemas = ElephantMemoryProvider().get_tool_schemas()
    names = sorted(s["function"]["name"] for s in schemas)
    assert names == [
        "memory_entity",
        "memory_forget",
        "memory_observe",
        "memory_preference_get",
        "memory_preference_set",
        "memory_recall",
        "memory_save",
        "memory_timeline",
    ]
    for schema in schemas:
        assert schema["type"] == "function"
        assert schema["function"]["parameters"]["type"] == "object"


def test_is_available_needs_the_token_env(monkeypatch):
    monkeypatch.delenv(elephant.TOKEN_ENV, raising=False)
    assert ElephantMemoryProvider().is_available() is False
    monkeypatch.setenv(elephant.TOKEN_ENV, "tok-12345678")
    assert ElephantMemoryProvider().is_available() is True


def test_memory_save_posts_scope_and_actor(provider, fake_http):
    fake_http.respond("POST", "/facts", {"id": FACT_ID})
    out = provider.handle_tool_call("memory_save", {"fact": "user prefers espresso"})
    assert FACT_ID in out
    post = next(r for r in fake_http.requests if r["path"] == "/facts")
    assert post["body"]["content"] == "user prefers espresso"
    assert post["body"]["agentId"] == "hermes"
    assert post["body"]["sessionId"] == "session-1"
    assert post["body"]["actor"] == "hermes"


def test_memory_forget_rejects_non_uuid_without_request(provider, fake_http):
    before = len(fake_http.requests)
    out = provider.handle_tool_call("memory_forget", {"factId": "../dream"})
    assert out == "factId must be a UUID."
    assert len(fake_http.requests) == before


def test_memory_forget_fuzzy_hard_filters_to_own_agent(provider, fake_http):
    fake_http.respond("GET", "/recall", {"facts": []})
    out = provider.handle_tool_call("memory_forget", {"query": "old belief"})
    assert out == "No matching facts."
    recall = next(r for r in fake_http.requests if r["path"] == "/recall")
    assert recall["query"]["agentScope"] == "filter"
    assert recall["query"]["agentId"] == "hermes"


def test_prefetch_renders_recall_block(provider, fake_http):
    fake_http.respond(
        "GET",
        "/recall",
        {
            "facts": [
                {
                    "id": FACT_ID,
                    "content": "espresso wins",
                    "score": 0.91,
                    "category": "preference",
                }
            ],
            "preferences": [{"key": "coffee", "value": "espresso"}],
        },
    )
    block = provider.prefetch("what coffee do I like?")
    assert block.startswith("[elephant memory]")
    assert "coffee: espresso" in block
    assert "espresso wins" in block


def test_prefetch_swallows_errors(provider, monkeypatch):
    def boom(req, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    assert provider.prefetch("anything") == ""


def test_sync_turn_is_non_blocking_and_worker_posts(provider, fake_http):
    fake_http.respond("POST", "/episodes", {"episodeId": "e1"})
    fake_http.posted.clear()
    provider.sync_turn(
        "remember that I switched the deploy day to thursday",
        "Noted — deploys now happen on Thursday.",
        session_id="session-1",
    )
    assert fake_http.posted.wait(timeout=5), "worker never posted the episode"
    provider._queue.join()
    episode = next(r for r in fake_http.requests if r["path"] == "/episodes")
    assert "USER: remember" in episode["body"]["rawTranscript"]
    assert episode["body"]["agentId"] == "hermes"
    assert episode["body"]["sessionId"] == "session-1"


def test_trivial_turns_are_skipped(provider, fake_http):
    before = len(fake_http.requests)
    provider.sync_turn("hi", "hello!", session_id="session-1")
    provider._queue.join()
    assert len(fake_http.requests) == before


def test_on_pre_compress_flushes_snapshot(provider, fake_http):
    fake_http.respond("POST", "/episodes", {"episodeId": "e2"})
    out = provider.on_pre_compress(
        [
            {"role": "user", "content": "a long discussion about the migration plan for the api"},
            {"role": "assistant", "content": "here is the full migration plan in detail..."},
        ]
    )
    assert out == ""
    provider._queue.join()
    episode = next(r for r in fake_http.requests if r["path"] == "/episodes")
    assert "[pre-compression snapshot]" in episode["body"]["rawTranscript"]


def test_on_memory_write_mirrors_adds(provider, fake_http):
    fake_http.respond("POST", "/facts", {"id": FACT_ID})
    provider.on_memory_write("append", "MEMORY.md", "user timezone is US/Eastern")
    post = next(r for r in fake_http.requests if r["path"] == "/facts")
    assert post["body"]["content"] == "user timezone is US/Eastern"
    assert post["body"]["actor"] == "hermes:builtin-mirror"


def test_preference_get_handles_404(provider, monkeypatch):
    def not_found(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 404, "not found", {}, io.BytesIO(b'{"ok":false,"error":"not found"}')
        )

    import urllib.error

    monkeypatch.setattr(urllib.request, "urlopen", not_found)
    out = provider.handle_tool_call("memory_preference_get", {"key": "unset"})
    assert out == 'Preference "unset" is not set.'


def test_save_config_writes_non_secrets(tmp_path):
    provider = ElephantMemoryProvider()
    provider.save_config({"token": "secret!", "url": "http://x:1", "agent_id": "h2"}, str(tmp_path))
    saved = json.loads((tmp_path / "elephant.json").read_text())
    assert saved == {"url": "http://x:1", "agent_id": "h2"}


def test_client_encodes_path_segments(fake_http):
    client = ElephantClient("http://elephant.test", "tok-12345678")
    fake_http.respond("DELETE", "/facts/", {"deleted": True})
    client.delete_fact("../dream")
    assert fake_http.requests[-1]["path"] == "/facts/..%2Fdream"


def test_client_raises_elephant_error_on_4xx(monkeypatch):
    import urllib.error

    def bad_request(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 400, "bad", {}, io.BytesIO(b'{"ok":false,"error":"bad input"}')
        )

    monkeypatch.setattr(urllib.request, "urlopen", bad_request)
    client = ElephantClient("http://elephant.test", "tok-12345678", retries=0)
    with pytest.raises(ElephantError) as excinfo:
        client.save_fact(content="")
    assert excinfo.value.status == 400
    assert "bad input" in str(excinfo.value)
