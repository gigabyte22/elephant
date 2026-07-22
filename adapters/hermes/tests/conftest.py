import json
import os
import sys
import uuid

import pytest

# Make the plugin importable as the package `elephant` without a hermes checkout.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ─ live-server fixtures ─────────────────────────────────────────────────────
#
# `pnpm test:hermes-live` (scripts/live-server.ts) boots a real elephant against
# a throwaway Neo4j testcontainer and exports these two variables. When they are
# absent — the normal `uv run pytest -q` case — every live test skips, so the
# fast fake-transport suite still runs with no Docker and no network.

LIVE_URL_ENV = "ELEPHANT_LIVE_URL"
LIVE_TOKEN_ENV = "ELEPHANT_SERVICE_TOKEN"


def live_target():
    """(url, token) for the live server, or None when not running live."""
    url = os.environ.get(LIVE_URL_ENV)
    token = os.environ.get(LIVE_TOKEN_ENV)
    return (url, token) if url and token else None


requires_live = pytest.mark.skipif(
    live_target() is None,
    reason=f"live server not configured — set {LIVE_URL_ENV}/{LIVE_TOKEN_ENV} "
    "or run `pnpm test:hermes-live`",
)


@pytest.fixture(scope="session")
def live(request):
    target = live_target()
    if target is None:
        pytest.skip("live server not configured")
    return target


@pytest.fixture(scope="session")
def live_client(live):
    from elephant.client import ElephantClient

    url, token = live
    # retries=0: against a local server a retry only masks a real failure.
    return ElephantClient(url, token, retries=0)


def _make_provider(tmp_path, url, token, config, session_id):
    import elephant
    from elephant import ElephantMemoryProvider

    home = tmp_path / f"hermes-home-{uuid.uuid4().hex[:8]}"
    home.mkdir(parents=True, exist_ok=True)
    (home / elephant.CONFIG_FILE).write_text(
        json.dumps({"url": url, **config}), encoding="utf-8"
    )
    os.environ[elephant.TOKEN_ENV] = token
    # `ELEPHANT_URL` wins over the file; keep them in agreement so a stray value
    # inherited from the harness can never point a test at another server.
    os.environ["ELEPHANT_URL"] = url
    provider = ElephantMemoryProvider()
    provider.initialize(session_id, hermes_home=str(home))
    return provider


@pytest.fixture(scope="session")
def scope_ids():
    """One isolated project/user/session triple for the whole live run."""
    tag = uuid.uuid4().hex[:10]
    return {
        "project_id": f"proj-{tag}",
        "user_id": f"user-{tag}",
        "session_id": f"sess-{tag}",
        "tag": tag,
    }


@pytest.fixture(scope="session")
def live_provider(live, scope_ids, tmp_path_factory):
    """Fully scoped provider: project + user configured (the research path
    requires a project, and the scope-filtered list endpoints need both)."""
    url, token = live
    provider = _make_provider(
        tmp_path_factory.mktemp("scoped"),
        url,
        token,
        {
            "agent_id": "hermes-live",
            "project_id": scope_ids["project_id"],
            "user_id": scope_ids["user_id"],
            "auto_recall_limit": 25,
        },
        scope_ids["session_id"],
    )
    yield provider
    provider.shutdown()


@pytest.fixture(scope="session")
def bare_provider(live, tmp_path_factory):
    """Provider with NO project_id/user_id configured. This is the shape that
    exposes null-vs-absent bugs: every optional scope axis resolves to None, and
    zod `.optional()` rejects an explicit JSON null."""
    url, token = live
    provider = _make_provider(
        tmp_path_factory.mktemp("bare"),
        url,
        token,
        {"agent_id": "hermes-bare"},
        f"bare-{uuid.uuid4().hex[:8]}",
    )
    yield provider
    provider.shutdown()
