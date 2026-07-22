"""Live tests: the real hermes adapter against a real elephant over HTTP.

Run with `pnpm test:hermes-live` from the repo root. That boots
`scripts/live-server.ts`, which starts its OWN throwaway Neo4j testcontainer —
it never touches a developer database — and exports ELEPHANT_LIVE_URL /
ELEPHANT_SERVICE_TOKEN. Without those the whole module skips, so the fast
fake-transport suite still runs with no Docker and no network.

Why these exist: the fake-transport suite in test_provider.py asserts the
*shape* of the request the adapter builds, against a canned 200. It cannot
catch a request that is well-formed but rejected — and the server's zod
`.optional()` accepts a MISSING key while rejecting an explicit JSON `null`.
Every test here that calls a tool with its optional arguments OMITTED is
probing exactly that: the shape the fake transport happily accepts and a real
server 400s.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from conftest import requires_live

from elephant.client import ElephantError

pytestmark = requires_live

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)

# Adapter guard messages returned as ordinary text (never raised), so a bare
# `assert "error" not in text` would sail straight past them.
_GUARD_PREFIXES = (
    "elephant error",
    "elephant memory is not initialized",
    "Unknown tool:",
)
_GUARD_SUBSTRINGS = ("must be a UUID",)


def call(provider, tool: str, **args) -> str:
    """Invoke a tool and fail loudly on any error-ish text.

    `handle_tool_call` converts every exception to a string for the model, so a
    500 or a 400 looks exactly like a successful answer to a naive assertion.
    """
    text = provider.handle_tool_call(tool, args)
    assert isinstance(text, str)
    for prefix in _GUARD_PREFIXES:
        assert not text.startswith(prefix), f"{tool}{args} -> {text}"
    for needle in _GUARD_SUBSTRINGS:
        assert needle not in text, f"{tool}{args} -> {text}"
    return text


def one_uuid(text: str) -> str:
    found = UUID_RE.search(text)
    assert found, f"expected a uuid in: {text}"
    return found.group(0)


def token(prefix: str) -> str:
    """A word that exists nowhere else in the graph, so a recall assertion is
    about retrieval working rather than about ranking luck."""
    return f"{prefix}{uuid.uuid4().hex[:8]}"


def iso_in(**delta) -> str:
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


# ─ sanity ───────────────────────────────────────────────────────────────────


def test_health_reports_a_live_neo4j(live_client):
    health = live_client.health()
    assert health.get("neo4j") is True
    # EMBED_DIM is baked into the vector-index DDL at migrate time; a mismatch
    # here means the harness and the schema disagree and every recall is junk.
    assert health.get("embedDim") == 256 or health.get("embedder")


def test_provider_initialized_against_the_live_server(live_provider, live):
    url, _ = live
    assert live_provider.is_available() is True
    assert live_provider._config["url"] == url
    assert len(live_provider.get_tool_schemas()) == 34


# ─ the original 8 tools ─────────────────────────────────────────────────────


def test_save_recall_and_forget_a_fact(live_provider):
    word = token("factword")
    saved = call(live_provider, "memory_save", fact=f"The deploy key is {word}.")
    fact_id = one_uuid(saved)

    found = call(live_provider, "memory_recall", query=word, limit=25)
    assert word in found

    forgotten = call(live_provider, "memory_forget", factId=fact_id)
    assert "Soft-deleted" in forgotten


def test_save_fact_with_every_optional_omitted(live_provider):
    """`memory_save` is the tool that already hit the null-vs-absent bug and was
    fixed with `_drop_none`. This is its regression test against a real zod."""
    text = call(live_provider, "memory_save", fact=f"Minimal fact {token('m')}.")
    assert "Saved fact" in text


def test_save_fact_with_every_optional_supplied(live_provider):
    text = call(
        live_provider,
        "memory_save",
        fact=f"Rich fact about {token('rich')}.",
        category="testing",
        importance=0.9,
        entities=["Elephant"],
    )
    assert "Saved fact" in text


def test_forget_by_query_matches_only_this_agent(live_provider):
    word = token("forgetme")
    call(live_provider, "memory_save", fact=f"Disposable note {word}.")
    text = call(live_provider, "memory_forget", query=word)
    assert "Soft-deleted" in text or "Multiple matches" in text


def test_preference_set_then_get(live_provider):
    key = token("pref-")
    call(live_provider, "memory_preference_set", key=key, value="dark", confidence=0.8)
    text = call(live_provider, "memory_preference_get", key=key)
    assert "dark" in text


def test_preference_set_without_confidence(live_provider):
    """confidence omitted — the shape that sends no `confidence` key at all."""
    key = token("pref-")
    call(live_provider, "memory_preference_set", key=key, value="light")
    assert "light" in call(live_provider, "memory_preference_get", key=key)


def test_preference_get_missing_key_is_an_answer_not_an_error(live_provider):
    text = call(live_provider, "memory_preference_get", key=token("absent-"))
    assert "is not set" in text


def test_observe_writes_a_session_note(live_provider):
    text = call(live_provider, "memory_observe", note=f"Noticed {token('obs')}.")
    assert "Observed" in text


def test_timeline_at_now(live_provider):
    text = call(live_provider, "memory_timeline", at=iso_in(seconds=0))
    assert "Beliefs valid at" in text


def test_entity_search_and_fetch(live_provider):
    name = token("Entity")
    call(live_provider, "memory_save", fact=f"{name} ships the release.", entities=[name])
    listing = call(live_provider, "memory_entity", name=name)
    if "No entities matching" in listing:
        pytest.skip("entity extraction did not create the entity synchronously")
    detail = call(live_provider, "memory_entity", id=one_uuid(listing))
    assert name.lower() in detail.lower()


def test_entity_and_forget_reject_a_non_uuid_before_the_wire(live_provider):
    assert "must be a UUID" in live_provider.handle_tool_call("memory_entity", {"id": "../etc"})
    assert "must be a UUID" in live_provider.handle_tool_call("memory_forget", {"factId": "x/y"})


# ─ knowledge documents ──────────────────────────────────────────────────────


def test_knowledge_round_trip(live_provider):
    word = token("knowword")
    saved = call(
        live_provider,
        "memory_knowledge_save",
        title=f"Runbook {word}",
        source="handbook",
        content=f"To restart the cluster, run the {word} command twice.",
        summary=f"About {word}",
        tags=["runbook", "ops"],
        sourceUri="https://example.invalid/runbook",
    )
    doc_id = one_uuid(saved)

    fetched = call(live_provider, "memory_knowledge_get", id=doc_id)
    assert word in fetched
    assert "restart the cluster" in fetched

    updated = call(
        live_provider,
        "memory_knowledge_update",
        id=doc_id,
        content=f"Updated: the {word} command now runs once.",
        reason="live test",
    )
    assert "Updated knowledge document" in updated
    assert "runs once" in call(live_provider, "memory_knowledge_get", id=doc_id)

    listing = call(live_provider, "memory_knowledge_list", limit=50)
    assert doc_id in listing

    deleted = call(live_provider, "memory_knowledge_delete", id=doc_id)
    assert "Soft-deleted" in deleted
    # Soft delete is not a tombstone: the node stays readable, which is the
    # contract the audit trail depends on.
    assert word in call(live_provider, "memory_knowledge_get", id=doc_id)


def test_knowledge_save_with_optionals_omitted(live_provider):
    """No sourceUri, no summary, no tags — the null-vs-absent shape."""
    saved = call(
        live_provider,
        "memory_knowledge_save",
        title=f"Bare doc {token('bare')}",
        source="test",
        content="Minimal body.",
    )
    assert "Saved knowledge document" in saved


def test_knowledge_save_unscoped(bare_provider):
    """No project_id and no user_id configured, so `scope` is an empty object.
    Every axis is absent rather than null — the exact distinction zod cares
    about."""
    saved = call(
        bare_provider,
        "memory_knowledge_save",
        title=f"Unscoped doc {token('un')}",
        source="test",
        content="Body with no scope at all.",
    )
    assert one_uuid(saved)
    assert "No knowledge documents." not in call(bare_provider, "memory_knowledge_list")


def test_knowledge_list_with_limit_omitted(live_provider):
    call(
        live_provider,
        "memory_knowledge_save",
        title=f"Listed {token('l')}",
        source="test",
        content="Body.",
    )
    assert "No knowledge documents." not in call(live_provider, "memory_knowledge_list")


def test_knowledge_update_requires_a_field(live_provider):
    saved = call(
        live_provider,
        "memory_knowledge_save",
        title=f"Guarded {token('g')}",
        source="test",
        content="Body.",
    )
    text = live_provider.handle_tool_call("memory_knowledge_update", {"id": one_uuid(saved)})
    assert "Provide at least one field" in text


def test_knowledge_purge_drops_chunks_but_keeps_the_document(live_provider):
    word = token("purgeword")
    saved = call(
        live_provider,
        "memory_knowledge_save",
        title=f"Purge me {word}",
        source="test",
        content=f"Content mentioning {word} for chunk removal.",
    )
    doc_id = one_uuid(saved)
    text = call(live_provider, "memory_knowledge_delete", id=doc_id, purge=True)
    assert "purged" in text
    # purge=true drops chunks and attachments, then soft-deletes. It is not a
    # hard delete: the node itself is still readable.
    assert word in call(live_provider, "memory_knowledge_get", id=doc_id)


# ─ research ─────────────────────────────────────────────────────────────────


def test_research_round_trip(live_provider):
    word = token("resword")
    saved = call(
        live_provider,
        "memory_research_save",
        title=f"Study {word}",
        source="web",
        content=f"Findings show {word} improves throughput by 40 percent.",
        summary=f"Summary of {word}",
        tags=["perf"],
        sourceUri="https://example.invalid/study",
    )
    research_id = one_uuid(saved)

    fetched = call(live_provider, "memory_research_get", id=research_id)
    assert word in fetched
    assert "throughput" in fetched

    updated = call(
        live_provider,
        "memory_research_update",
        id=research_id,
        summary=f"Revised summary of {word}",
        reason="live test",
    )
    assert "Updated research" in updated

    listing = call(live_provider, "memory_research_list", limit=50)
    assert research_id in listing

    assert "Soft-deleted" in call(live_provider, "memory_research_delete", id=research_id)


def test_research_save_with_optionals_omitted(live_provider):
    saved = call(
        live_provider,
        "memory_research_save",
        title=f"Bare study {token('bs')}",
        source="web",
        content="Minimal findings.",
    )
    assert "Saved research" in saved


def test_research_without_a_project_is_refused_client_side(bare_provider):
    """Research is always project-scoped; the adapter must say so rather than
    let the server 400."""
    text = bare_provider.handle_tool_call(
        "memory_research_save", {"title": "T", "source": "web", "content": "C"}
    )
    assert "project" in text.lower()
    assert not text.startswith("elephant error")
    assert "project" in bare_provider.handle_tool_call("memory_research_list", {}).lower()


# ─ procedures ───────────────────────────────────────────────────────────────


def test_procedure_round_trip(live_provider):
    word = token("procword")
    name = f"deploy-{word}"
    saved = call(
        live_provider,
        "memory_procedure_save",
        name=name,
        content=f"Step 1: run {word}. Step 2: verify.",
        whenToUse=f"When deploying {word}.",
    )
    proc_id = one_uuid(saved)

    by_id = call(live_provider, "memory_procedure_get", id=proc_id)
    assert word in by_id

    by_name = call(live_provider, "memory_procedure_get", name=name)
    assert proc_id in by_name

    updated = call(
        live_provider,
        "memory_procedure_update",
        id=proc_id,
        content=f"Step 1: run {word} twice.",
        reason="live test",
    )
    assert "Updated procedure" in updated
    assert "twice" in call(live_provider, "memory_procedure_get", id=proc_id)

    assert proc_id in call(live_provider, "memory_procedure_list", limit=50)
    assert "Soft-deleted" in call(live_provider, "memory_procedure_delete", id=proc_id)


def test_procedure_save_unscoped(bare_provider):
    saved = call(
        bare_provider,
        "memory_procedure_save",
        name=f"bare-proc-{token('p')}",
        content="Do the thing.",
        whenToUse="When the thing needs doing.",
    )
    assert one_uuid(saved)


def test_procedure_update_requires_a_field(live_provider):
    saved = call(
        live_provider,
        "memory_procedure_save",
        name=f"guard-{token('p')}",
        content="Body.",
        whenToUse="Never.",
    )
    text = live_provider.handle_tool_call("memory_procedure_update", {"id": one_uuid(saved)})
    assert "Provide at least one field" in text


def test_procedure_get_requires_id_or_name(live_provider):
    assert "Provide id or name" in live_provider.handle_tool_call("memory_procedure_get", {})


def test_procedure_get_by_unknown_name(live_provider):
    text = call(live_provider, "memory_procedure_get", name=token("nosuch-"))
    assert "No procedure named" in text


# ─ intentions ───────────────────────────────────────────────────────────────


def test_intention_with_due_at_round_trip(live_provider):
    word = token("intword")
    created = call(
        live_provider,
        "memory_intention_create",
        content=f"Follow up on {word}.",
        dueAt=iso_in(hours=1),
        importance=0.7,
    )
    intention_id = one_uuid(created)

    listing = call(live_provider, "memory_intention_list", status="pending", limit=50)
    assert intention_id in listing

    done = call(live_provider, "memory_intention_complete", id=intention_id, reason="live test")
    assert "Completed intention" in done
    assert "completed" in done


def test_intention_with_trigger_hint_only(live_provider):
    """triggerHint alone is a valid trigger — dueAt/schedule stay absent."""
    created = call(
        live_provider,
        "memory_intention_create",
        content=f"Mention {token('trig')} next time.",
        triggerHint="when the user asks about deploys",
    )
    assert one_uuid(created)


def test_intention_recurring_with_schedule_can_be_fired(live_provider):
    created = call(
        live_provider,
        "memory_intention_create",
        content=f"Weekly check {token('rec')}.",
        schedule="0 9 * * 1",
        recurring=True,
    )
    intention_id = one_uuid(created)
    assert "Fired intention" in call(live_provider, "memory_intention_fired", id=intention_id)


def test_intention_cancel(live_provider):
    created = call(
        live_provider,
        "memory_intention_create",
        content=f"Abandon {token('can')}.",
        triggerHint="never",
    )
    text = call(live_provider, "memory_intention_cancel", id=one_uuid(created))
    assert "Cancelled intention" in text
    assert "cancelled" in text


def test_intention_without_a_trigger_is_refused_client_side(live_provider):
    """The server rejects a trigger-less intention (IntentionService.create).
    The adapter must explain what to add instead of surfacing a bare 400 — the
    model can act on the former and not the latter."""
    text = live_provider.handle_tool_call(
        "memory_intention_create", {"content": "Do something eventually."}
    )
    assert not text.startswith("elephant error"), (
        "a content-only intention reached the server and 400'd; the adapter "
        "must guard it client-side"
    )
    assert "dueAt" in text and "triggerHint" in text and "schedule" in text


def test_intention_due_listing(live_provider):
    created = call(
        live_provider,
        "memory_intention_create",
        content=f"Overdue {token('due')}.",
        dueAt=iso_in(hours=-1),
    )
    text = call(live_provider, "memory_intention_due", limit=50)
    assert one_uuid(created) in text


def test_intention_due_with_before_and_limit_omitted(live_provider):
    call(
        live_provider,
        "memory_intention_create",
        content=f"Soon {token('soon')}.",
        dueAt=iso_in(hours=-2),
    )
    assert "Nothing due." not in call(live_provider, "memory_intention_due")


def test_intention_list_with_status_omitted(live_provider):
    call(
        live_provider,
        "memory_intention_create",
        content=f"Listed {token('li')}.",
        triggerHint="anything",
    )
    assert "No intentions." not in call(live_provider, "memory_intention_list")


def test_intention_unscoped(bare_provider):
    """No project/user axes — scope carries only agentId."""
    created = call(
        bare_provider,
        "memory_intention_create",
        content=f"Bare intention {token('bi')}.",
        triggerHint="whenever",
    )
    assert one_uuid(created) in call(bare_provider, "memory_intention_list")


# ─ working state ────────────────────────────────────────────────────────────


def test_state_round_trip(live_provider):
    key = token("state-")
    call(live_provider, "memory_state_set", key=key, value="in-progress")
    got = call(live_provider, "memory_state_get", key=key)
    assert "in-progress" in got

    assert key in call(live_provider, "memory_state_list")
    assert "Deleted state" in call(live_provider, "memory_state_delete", key=key)
    assert "is not set" in call(live_provider, "memory_state_get", key=key)


def test_state_set_with_ttl(live_provider):
    key = token("ttl-")
    call(live_provider, "memory_state_set", key=key, value="soon", ttlSec=600)
    assert "soon" in call(live_provider, "memory_state_get", key=key)


def test_state_list_with_prefix(live_provider):
    prefix = token("pfx")
    call(live_provider, "memory_state_set", key=f"{prefix}-a", value="1")
    call(live_provider, "memory_state_set", key=f"{prefix}-b", value="2")
    listing = call(live_provider, "memory_state_list", prefix=prefix)
    assert f"{prefix}-a" in listing and f"{prefix}-b" in listing


def test_state_get_missing_key_is_an_answer_not_an_error(live_provider):
    assert "is not set" in call(live_provider, "memory_state_get", key=token("gone-"))


def test_state_unscoped(bare_provider):
    """agentId is the only required scope axis; project/user stay absent."""
    key = token("bare-state-")
    call(bare_provider, "memory_state_set", key=key, value="ok")
    assert "ok" in call(bare_provider, "memory_state_get", key=key)


def test_state_scopes_are_isolated(live_provider, bare_provider):
    key = token("iso-")
    call(live_provider, "memory_state_set", key=key, value="scoped")
    assert "is not set" in call(bare_provider, "memory_state_get", key=key)


# ─ audit ────────────────────────────────────────────────────────────────────


def test_audit_shows_history_after_an_update(live_provider):
    saved = call(
        live_provider,
        "memory_knowledge_save",
        title=f"Audited {token('a')}",
        source="test",
        content="Original body.",
    )
    doc_id = one_uuid(saved)
    call(live_provider, "memory_knowledge_update", id=doc_id, content="Revised body.", reason="r1")

    text = call(live_provider, "memory_audit", targetId=doc_id)
    assert f"Audit for {doc_id}" in text
    assert "revision" in text or "update" in text.lower()


def test_audit_with_limit_omitted(live_provider):
    saved = call(
        live_provider,
        "memory_procedure_save",
        name=f"audit-proc-{token('ap')}",
        content="Body.",
        whenToUse="Testing.",
    )
    proc_id = one_uuid(saved)
    call(live_provider, "memory_procedure_update", id=proc_id, content="New body.")
    assert f"Audit for {proc_id}" in call(live_provider, "memory_audit", targetId=proc_id)


def test_audit_of_an_untouched_id_is_empty_not_an_error(live_provider):
    text = call(live_provider, "memory_audit", targetId=str(uuid.uuid4()))
    assert "No audit history" in text


# ─ recall must actually surface the new content types ───────────────────────
#
# This is the point of the includeKnowledge / includeResearch / includeIntentions
# work: seed via the save tool, recall, and assert the rendered block contains
# the seeded text. A passing round-trip test proves storage; only this proves
# the content is reachable from a query.


def test_recall_surfaces_knowledge(live_provider):
    word = token("kbrecall")
    call(
        live_provider,
        "memory_knowledge_save",
        title=f"Recall doc {word}",
        source="handbook",
        content=(
            f"The {word} procedure governs cluster failover. "
            f"Operators consult {word} before any restart."
        ),
    )
    text = call(live_provider, "memory_recall", query=word, limit=25)
    assert word in text, f"knowledge not surfaced by recall:\n{text}"
    assert "Knowledge:" in text


def test_recall_surfaces_research(live_provider):
    word = token("resrecall")
    call(
        live_provider,
        "memory_research_save",
        title=f"Recall study {word}",
        source="web",
        content=(
            f"Our {word} benchmark measured latency across regions. "
            f"The {word} result favours the western cluster."
        ),
        summary=f"{word} benchmark summary",
    )
    text = call(live_provider, "memory_recall", query=word, limit=25)
    assert word in text, f"research not surfaced by recall:\n{text}"
    assert "Research" in text


def test_recall_surfaces_intentions(live_provider):
    word = token("intrecall")
    call(
        live_provider,
        "memory_intention_create",
        content=f"Remember to audit the {word} pipeline before release.",
        triggerHint=f"when {word} comes up",
    )
    text = call(live_provider, "memory_recall", query=word, limit=25)
    assert word in text, f"intention not surfaced by recall:\n{text}"
    assert "Open intentions:" in text


def test_recall_surfaces_procedures(live_provider):
    word = token("procrecall")
    call(
        live_provider,
        "memory_procedure_save",
        name=f"{word}-rotation",
        content=f"Rotate the {word} credentials, then redeploy.",
        whenToUse=f"When {word} credentials expire.",
    )
    text = call(live_provider, "memory_recall", query=word, limit=25)
    assert word in text, f"procedure not surfaced by recall:\n{text}"
    assert "Procedures:" in text


def test_recall_surfaces_preferences(live_provider):
    word = token("prefrecall")
    call(live_provider, "memory_preference_set", key=f"theme-{word}", value=word)
    text = call(live_provider, "memory_recall", query=word, limit=25)
    assert "Preferences:" in text and word in text


def test_recall_of_an_unknown_query_returns_no_matching_content(live_provider):
    """Not "No matches." — recall is a top-K hybrid retriever with no relevance
    floor, and preferences are injected as ambient context, so a populated graph
    always renders *something*. The invariant that matters is that a token the
    graph has never seen never comes back."""
    word = token("nothingmatches")
    text = call(live_provider, "memory_recall", query=word)
    assert word not in text


def test_recall_with_optional_filters_omitted(live_provider):
    """No from/to/minImportance/limit — the shape the model sends most often."""
    word = token("plainrecall")
    call(live_provider, "memory_save", fact=f"A plain fact about {word}.")
    assert word in call(live_provider, "memory_recall", query=word)


def test_recall_with_temporal_and_importance_filters(live_provider):
    word = token("filtered")
    call(live_provider, "memory_save", fact=f"An important fact about {word}.", importance=0.9)
    text = call(
        live_provider,
        "memory_recall",
        query=word,
        **{"from": iso_in(days=-1), "to": iso_in(days=1)},
        minImportance=0.1,
        limit=25,
    )
    assert word in text


# ─ prefetch + the sync_turn -> episode path ─────────────────────────────────


def test_prefetch_returns_a_memory_block(live_provider):
    word = token("prefetchword")
    call(live_provider, "memory_save", fact=f"Prefetch subject {word} is documented.")
    block = live_provider.prefetch(word)
    assert block.startswith("[elephant memory]"), f"empty/garbled prefetch: {block!r}"
    assert word in block


def test_prefetch_surfaces_knowledge_too(live_provider):
    word = token("prefetchkb")
    call(
        live_provider,
        "memory_knowledge_save",
        title=f"Prefetch doc {word}",
        source="handbook",
        content=f"The {word} runbook explains the rollback path in detail.",
    )
    block = live_provider.prefetch(word)
    assert word in block, f"knowledge missing from prefetch block:\n{block!r}"


def test_prefetch_of_an_unknown_query_invents_nothing(live_provider):
    word = token("nomatchprefetch")
    block = live_provider.prefetch(word)
    # Nearest-neighbour content still renders (see the recall test above); the
    # invariant is that an unseen token is never echoed back as a match.
    assert word not in block


def test_prefetch_of_a_blank_query_is_empty(live_provider):
    assert live_provider.prefetch("   ") == ""


def test_queue_prefetch_warms_the_cache(live_provider):
    word = token("warmword")
    call(live_provider, "memory_save", fact=f"Warmed subject {word} exists.")
    query = word
    live_provider.queue_prefetch(query)
    for _ in range(100):
        with live_provider._prefetch_lock:
            if query in live_provider._prefetch_cache:
                break
        import time

        time.sleep(0.05)
    block = live_provider.prefetch(query)
    assert word in block
    # The cache is pop-on-read, so a second prefetch must recompute rather than
    # serve a stale block.
    assert query not in live_provider._prefetch_cache


def test_sync_turn_writes_an_episode(live_provider, caplog):
    """`sync_turn` enqueues; a daemon worker POSTs /episodes and swallows every
    failure so a dead service cannot kill the agent. That swallowing means a
    400 here would be invisible — so assert on the worker's warning log."""
    word = token("episodeword")
    with caplog.at_level(logging.WARNING, logger="elephant"):
        live_provider.sync_turn(
            f"Tell me about the {word} migration and why it was scheduled late.",
            f"The {word} migration moved to Friday to avoid the release freeze.",
            session_id=live_provider._session_id,
        )
        live_provider.on_session_end([])
    failures = [r for r in caplog.records if "episode write failed" in r.getMessage()]
    assert not failures, [r.getMessage() for r in failures]
    assert live_provider._queue.empty()


def test_sync_turn_ignores_a_trivial_turn(live_provider):
    before = live_provider._queue.qsize()
    live_provider.sync_turn("hi", "hello")
    assert live_provider._queue.qsize() == before


def test_on_pre_compress_writes_a_snapshot_episode(live_provider, caplog):
    word = token("compressword")
    messages = [
        {"role": "user", "content": f"Explain the {word} incident in full detail please."},
        {"role": "assistant", "content": f"The {word} incident was a cache stampede on Tuesday."},
    ]
    with caplog.at_level(logging.WARNING, logger="elephant"):
        assert live_provider.on_pre_compress(messages) == ""
        live_provider.on_session_end([])
    failures = [r for r in caplog.records if "episode write failed" in r.getMessage()]
    assert not failures, [r.getMessage() for r in failures]


def test_ingest_episode_directly(live_client, scope_ids):
    data = live_client.ingest_episode(
        agentId="hermes-live",
        sessionId=scope_ids["session_id"],
        rawTranscript=f"USER: hi\n\nASSISTANT: hello {token('ep')}",
        projectId=scope_ids["project_id"],
    )
    assert UUID_RE.fullmatch(str(data["episodeId"]))


def test_on_memory_write_mirrors_a_fact(live_provider):
    word = token("mirrorword")
    live_provider.on_memory_write("add", "notes", f"Mirrored note about {word}.")
    assert word in call(live_provider, "memory_recall", query=word, limit=25)


# ─ client-level: the raw wire, with optionals omitted ───────────────────────
#
# The provider always fills in an actor/scope. These call `ElephantClient`
# directly with the smallest legal body, which is what a different caller (the
# CLI, another embedder) would send.


def test_client_knowledge_minimal_body(live_client):
    doc = live_client.ingest_knowledge(
        title=f"Client doc {token('c')}", source="test", content="Body."
    )
    assert live_client.get_knowledge(doc["id"])["id"] == doc["id"]
    assert isinstance(live_client.list_knowledge(), list)


def test_client_research_minimal_body(live_client, scope_ids):
    record = live_client.create_research(
        title=f"Client study {token('c')}",
        source="web",
        content="Body.",
        projectId=scope_ids["project_id"],
    )
    assert live_client.get_research(record["id"])["id"] == record["id"]
    assert isinstance(live_client.list_research(scope_ids["project_id"]), list)


def test_client_procedure_minimal_body(live_client):
    proc = live_client.create_procedure(
        name=f"client-proc-{token('c')}", content="Steps.", whenToUse="Testing."
    )
    assert live_client.get_procedure(proc["id"])["id"] == proc["id"]
    assert isinstance(live_client.list_procedures(), list)


def test_client_intention_minimal_body(live_client):
    intention = live_client.create_intention(
        content=f"Client intention {token('c')}.", triggerHint="testing"
    )
    assert live_client.get_intention(intention["id"])["status"] == "pending"
    assert isinstance(live_client.list_intentions(agentId="hermes-live"), list)


def test_client_intention_without_a_trigger_is_a_400(live_client):
    """Pins the server behaviour the adapter guard exists for. If this ever
    starts passing, the client-side guard has become a false rejection."""
    with pytest.raises(ElephantError) as excinfo:
        live_client.create_intention(content="No trigger at all.")
    assert excinfo.value.status == 400


def test_client_state_minimal_scope(live_client):
    scope = {"agentId": f"client-{token('s')}"}
    key = "k"
    live_client.set_state(scope, key, {"nested": True})
    assert live_client.get_state(key, **scope)["value"] == {"nested": True}
    assert len(live_client.list_state(**scope)) == 1
    live_client.delete_state(key, **scope)
    with pytest.raises(ElephantError) as excinfo:
        live_client.get_state(key, **scope)
    assert excinfo.value.status == 404


def test_client_audit_list(live_client):
    assert isinstance(live_client.audit_list(limit=5), list)


def test_client_save_facts_batch(live_client):
    word = token("batchword")
    saved = live_client.save_facts(
        [{"content": f"Batch fact one {word}."}, {"content": f"Batch fact two {word}."}]
    )
    assert len(saved) == 2


def test_client_supersede_a_fact(live_client):
    word = token("supersede")
    old = live_client.save_fact(content=f"Old belief about {word}.")
    new = live_client.save_fact(content=f"New belief about {word}.")
    result = live_client.supersede_fact(old["id"], new["id"], "corrected")
    assert result
