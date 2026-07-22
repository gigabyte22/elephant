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


@pytest.fixture
def scoped_provider(fake_http, monkeypatch, tmp_path):
    """Provider with project/user scope configured — research and the scope
    bodies only exercise their real shape when those axes are set."""
    monkeypatch.setenv(elephant.TOKEN_ENV, "tok-12345678")
    (tmp_path / "elephant.json").write_text(json.dumps({"project_id": "proj-1", "user_id": "u-1"}))
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
        "memory_audit",
        "memory_entity",
        "memory_forget",
        "memory_intention_cancel",
        "memory_intention_complete",
        "memory_intention_create",
        "memory_intention_due",
        "memory_intention_fired",
        "memory_intention_list",
        "memory_knowledge_delete",
        "memory_knowledge_get",
        "memory_knowledge_list",
        "memory_knowledge_save",
        "memory_knowledge_update",
        "memory_observe",
        "memory_preference_get",
        "memory_preference_set",
        "memory_procedure_delete",
        "memory_procedure_get",
        "memory_procedure_list",
        "memory_procedure_save",
        "memory_procedure_update",
        "memory_recall",
        "memory_research_delete",
        "memory_research_get",
        "memory_research_list",
        "memory_research_save",
        "memory_research_update",
        "memory_save",
        "memory_state_delete",
        "memory_state_get",
        "memory_state_list",
        "memory_state_set",
        "memory_timeline",
    ]
    for schema in schemas:
        assert schema["type"] == "function"
        assert schema["function"]["parameters"]["type"] == "object"


def test_every_tool_schema_has_a_dispatch_branch(provider, fake_http):
    """A schema with no branch would fall through to "Unknown tool" at runtime."""
    minimal = {
        "query": "q",
        "fact": "f",
        "at": "2026-01-01T00:00:00Z",
        "key": "k",
        "value": "v",
        "note": "n",
        "name": "n",
        "title": "t",
        "source": "s",
        "content": "c",
        "whenToUse": "w",
        "id": FACT_ID,
        "targetId": FACT_ID,
    }
    for schema in provider.get_tool_schemas():
        name = schema["function"]["name"]
        required = schema["function"]["parameters"]["required"]
        args = {k: minimal[k] for k in required}
        out = provider.handle_tool_call(name, args)
        assert not out.startswith("Unknown tool"), name


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
    # Unset scope axes are omitted, not sent as nulls: z.optional() 400s on null.
    assert "projectId" not in post["body"]
    assert "category" not in post["body"]


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


def test_recall_opts_into_the_v12_categories(provider, fake_http):
    fake_http.respond("GET", "/recall", {"facts": []})
    provider.handle_tool_call("memory_recall", {"query": "anything"})
    query = next(r for r in fake_http.requests if r["path"] == "/recall")["query"]
    for flag in ("includeKnowledge", "includeResearch", "includeIntentions", "includeProcedures"):
        assert query[flag] == "true", flag


def test_tool_recall_and_prefetch_use_the_same_scope(provider, fake_http):
    fake_http.respond("GET", "/recall", {"facts": []})
    provider.prefetch("same question")
    provider.handle_tool_call("memory_recall", {"query": "same question"})
    prefetch_q, tool_q = (r["query"] for r in fake_http.requests if r["path"] == "/recall")
    axes = ("agentScope", "sessionScope", "projectScope", "userScope")
    assert {a: prefetch_q.get(a) for a in axes} == {a: tool_q.get(a) for a in axes}
    assert tool_q["sessionScope"] == "boost"


def test_format_recall_renders_the_new_sections():
    block = elephant._format_recall(
        {
            "knowledgeChunks": [{"documentId": "d1", "text": "chunk body"}],
            "research": [{"id": "r1", "title": "Vector DBs", "summary": "a survey"}],
            "researchChunks": [{"researchId": "r1", "text": "excerpt body"}],
            "intentions": [
                {"id": "i1", "status": "pending", "dueAt": "2026-08-01", "content": "ship it"}
            ],
        }
    )
    assert "Knowledge:" in block and "chunk body" in block
    assert "Research:" in block and "Vector DBs" in block
    assert "Research excerpts:" in block and "excerpt body" in block
    assert "Open intentions:" in block and "ship it" in block and "due 2026-08-01" in block


def test_format_recall_tolerates_missing_and_malformed_fields():
    # Every section key absent, null, wrong type, or holding non-dict members.
    assert elephant._format_recall({}) == ""
    block = elephant._format_recall(
        {
            "preferences": None,
            "facts": [{"id": "f1", "score": "not-a-number"}, "junk"],
            "insights": "not-a-list",
            "intentions": [{}],
        }
    )
    assert "f1" in block
    assert "Open intentions:" in block


def test_prefetch_survives_a_malformed_recall_payload(provider, fake_http):
    fake_http.respond("GET", "/recall", {"facts": "not-a-list", "preferences": 7})
    assert provider.prefetch("what changed?") == ""


def test_knowledge_save_posts_scope_and_actor(scoped_provider, fake_http):
    fake_http.respond("POST", "/knowledge/documents", {"id": FACT_ID, "title": "Runbook"})
    out = scoped_provider.handle_tool_call(
        "memory_knowledge_save", {"title": "Runbook", "source": "wiki", "content": "steps"}
    )
    assert FACT_ID in out
    post = next(r for r in fake_http.requests if r["path"] == "/knowledge/documents")
    assert post["body"]["scope"] == {"projectId": "proj-1", "userId": "u-1"}
    assert post["body"]["actor"] == "hermes"
    # Absent optionals must be omitted, not sent as nulls — the server's zod
    # `.optional()` rejects an explicit null.
    assert "summary" not in post["body"]
    assert "sourceUri" not in post["body"]


def test_knowledge_delete_sends_literal_purge_enum(scoped_provider, fake_http):
    fake_http.respond("DELETE", "/knowledge/documents/", {"deleted": True, "chunksDeleted": 3})
    scoped_provider.handle_tool_call("memory_knowledge_delete", {"id": FACT_ID})
    assert fake_http.requests[-1]["query"]["purge"] == "false"
    scoped_provider.handle_tool_call("memory_knowledge_delete", {"id": FACT_ID, "purge": True})
    assert fake_http.requests[-1]["query"]["purge"] == "true"


def test_knowledge_update_needs_a_field(scoped_provider, fake_http):
    before = len(fake_http.requests)
    out = scoped_provider.handle_tool_call("memory_knowledge_update", {"id": FACT_ID})
    assert out == "Provide at least one field to update."
    assert len(fake_http.requests) == before


def test_research_save_without_a_project_makes_no_request(provider, fake_http):
    before = len(fake_http.requests)
    out = provider.handle_tool_call(
        "memory_research_save", {"title": "t", "source": "s", "content": "c"}
    )
    assert "project" in out.lower()
    assert len(fake_http.requests) == before


def test_research_save_sends_the_configured_project(scoped_provider, fake_http):
    fake_http.respond("POST", "/research", {"id": FACT_ID, "title": "Survey"})
    out = scoped_provider.handle_tool_call(
        "memory_research_save", {"title": "Survey", "source": "web", "content": "body"}
    )
    assert FACT_ID in out
    post = next(r for r in fake_http.requests if r["path"] == "/research")
    assert post["body"]["projectId"] == "proj-1"
    assert post["body"]["userId"] == "u-1"


def test_procedure_get_by_name_queries_the_list_route(scoped_provider, fake_http):
    fake_http.respond(
        "GET", "/procedures", [{"id": FACT_ID, "name": "deploy", "version": 2, "content": "steps"}]
    )
    out = scoped_provider.handle_tool_call("memory_procedure_get", {"name": "deploy"})
    assert "deploy" in out and "steps" in out
    query = next(r for r in fake_http.requests if r["path"] == "/procedures")["query"]
    assert query["name"] == "deploy"
    assert query["projectId"] == "proj-1"


def test_intention_create_stamps_session_but_list_does_not(scoped_provider, fake_http):
    fake_http.respond("POST", "/intentions", {"id": FACT_ID})
    fake_http.respond("GET", "/intentions", [])
    # A trigger is mandatory server-side, so every valid create carries one.
    scoped_provider.handle_tool_call(
        "memory_intention_create",
        {"content": "follow up friday", "triggerHint": "when friday planning starts"},
    )
    post = next(r for r in fake_http.requests if r["path"] == "/intentions" and r["body"])
    assert post["body"]["scope"]["sessionId"] == "session-1"
    assert post["body"]["scope"]["agentId"] == "hermes"
    # Reads must not filter on session, or commitments made in an earlier
    # session become invisible.
    scoped_provider.handle_tool_call("memory_intention_list", {})
    listing = fake_http.requests[-1]
    assert listing["path"] == "/intentions"
    assert "sessionId" not in listing["query"]
    assert listing["query"]["agentId"] == "hermes"


def test_intention_create_without_a_trigger_never_reaches_the_wire(provider, fake_http):
    # IntentionService.create rejects an intention with no dueAt/triggerHint/
    # schedule. Guarding client-side turns a dead-end 400 into an instruction
    # the model can act on.
    before = len(fake_http.requests)
    out = provider.handle_tool_call("memory_intention_create", {"content": "someday"})
    assert "dueAt" in out and "triggerHint" in out and "schedule" in out
    assert len(fake_http.requests) == before


def test_intention_complete_rejects_non_uuid_without_request(provider, fake_http):
    before = len(fake_http.requests)
    out = provider.handle_tool_call("memory_intention_complete", {"id": "../dream"})
    assert out == "id must be a UUID."
    assert len(fake_http.requests) == before


def test_state_set_scopes_to_agent_and_session(provider, fake_http):
    fake_http.respond("POST", "/state", {"ok": True})
    provider.handle_tool_call("memory_state_set", {"key": "draft", "value": "hello"})
    post = next(r for r in fake_http.requests if r["path"] == "/state")
    assert post["body"]["scope"]["agentId"] == "hermes"
    assert post["body"]["scope"]["sessionId"] == "session-1"
    assert post["body"]["key"] == "draft"
    assert "ttlSec" not in post["body"]


def test_state_get_handles_404(provider, monkeypatch):
    import urllib.error

    def not_found(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 404, "not found", {}, io.BytesIO(b'{"ok":false,"error":"not found"}')
        )

    monkeypatch.setattr(urllib.request, "urlopen", not_found)
    out = provider.handle_tool_call("memory_state_get", {"key": "missing"})
    assert out == 'State key "missing" is not set.'


def test_audit_renders_events_and_revisions(provider, fake_http):
    fake_http.respond(
        "GET",
        "/audit/",
        {
            "events": [{"at": "2026-07-01", "kind": "update", "actor": "hermes"}],
            "revisions": [{"id": "rev-1", "archivedAt": "2026-07-01", "reason": "edit"}],
        },
    )
    out = provider.handle_tool_call("memory_audit", {"targetId": FACT_ID})
    assert "update by hermes" in out
    assert "revision rev-1" in out


def test_get_entity_include_superseded_is_a_parameter(fake_http):
    client = ElephantClient("http://elephant.test", "tok-12345678")
    fake_http.respond("GET", "/entities/", {"entity": {}, "facts": []})
    client.get_entity(FACT_ID)
    assert fake_http.requests[-1]["query"]["includeSuperseded"] == "false"
    client.get_entity(FACT_ID, include_superseded=True)
    assert fake_http.requests[-1]["query"]["includeSuperseded"] == "true"


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
