"""Tests for the dashboard config surface.

Hermes loads ``config_schema.py`` **by path**, never as part of the package
(``plugins/memory/config_schema.py``): provider ``__init__.py`` files pull in the
agent runtime, which must not load into the web server. These tests load it the
same way, against a stand-in for the ``plugins.memory.config_schema`` module so
no hermes checkout is needed.

The stand-in mirrors hermes's dataclasses only as far as this file uses them. If
hermes changes those shapes, the live check at the bottom is what catches it.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from dataclasses import dataclass, field as dataclass_field
from pathlib import Path

import pytest

from hermes_elephant.provider import ElephantMemoryProvider

SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent / "hermes_elephant" / "provider" / "config_schema.py"
)


@dataclass(frozen=True)
class _Option:
    value: str
    label: str
    description: str = ""


@dataclass(frozen=True)
class _Field:
    key: str
    label: str
    kind: str = "text"
    default: str = ""
    description: str = ""
    placeholder: str = ""
    options: tuple = ()
    env_key: str | None = None
    aliases: tuple = ()
    env_fallbacks: tuple = ()
    inline: bool = False
    group: str = ""
    info: str = ""
    scope: str = "host"


@dataclass(frozen=True)
class _Schema:
    name: str
    label: str
    storage: str = "flat_json"
    docs_url: str = ""
    fields: tuple = dataclass_field(default_factory=tuple)


def _load_schema(stub_module):
    """Exec config_schema.py by path, exactly as hermes's loader does."""
    sys.modules["plugins"] = type(sys)("plugins")
    sys.modules["plugins.memory"] = type(sys)("plugins.memory")
    sys.modules["plugins.memory.config_schema"] = stub_module
    try:
        spec = importlib.util.spec_from_file_location("_elephant_config_schema", SCHEMA_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.CONFIG_SCHEMA
    finally:
        for name in ("plugins.memory.config_schema", "plugins.memory", "plugins"):
            sys.modules.pop(name, None)


@pytest.fixture
def schema():
    stub = type(sys)("plugins.memory.config_schema")
    stub.KIND_TEXT = "text"
    stub.KIND_SELECT = "select"
    stub.KIND_SECRET = "secret"
    stub.KIND_BOOL = "bool"
    stub.KIND_NUMBER = "number"
    stub.KIND_JSON = "json"
    stub.ProviderField = _Field
    stub.ProviderFieldOption = _Option
    stub.ProviderConfigSchema = _Schema
    return _load_schema(stub)


def test_schema_identifies_as_the_elephant_provider(schema):
    # `name` must match the plugin directory, or the dashboard renders this
    # panel under the wrong provider.
    assert schema.name == "elephant"
    assert schema.label == "Elephant"


def test_token_is_a_secret_bound_to_the_env_var(schema):
    token = next(f for f in schema.fields if f.key == "token")
    assert token.kind == "secret"
    # is_available() and initialize() read exactly this variable, so the panel
    # must write it and not some near-miss.
    assert token.env_key == "ELEPHANT_SERVICE_TOKEN"


def test_url_falls_back_to_the_env_override(schema):
    url = next(f for f in schema.fields if f.key == "url")
    # initialize() prefers $ELEPHANT_URL over the config file; the dashboard has
    # to read the same override or it would display a URL that is not in use.
    assert "ELEPHANT_URL" in url.env_fallbacks
    assert url.default == "http://127.0.0.1:18790"


def test_every_declared_key_is_one_the_provider_reads(schema):
    """A field the provider ignores is a control that silently does nothing."""
    known = {f["key"] for f in ElephantMemoryProvider().get_config_schema()}
    assert {f.key for f in schema.fields} <= known


def test_secrets_are_not_written_to_the_config_file(schema, tmp_path):
    secret_keys = {f.key for f in schema.fields if f.kind == "secret"}
    provider = ElephantMemoryProvider()
    provider.save_config({"token": "tok-12345678", "url": "http://x"}, str(tmp_path))
    written = (tmp_path / "elephant.json").read_text(encoding="utf-8")
    for key in secret_keys:
        assert key not in written


@pytest.mark.skipif(
    not os.environ.get("HERMES_REPO"),
    reason="set HERMES_REPO=/path/to/hermes-agent to check against the real dataclasses",
)
def test_loads_against_a_real_hermes_checkout():
    """The stub above can drift from hermes. Point HERMES_REPO at a checkout to
    load the declaration through the genuine ProviderField/ProviderConfigSchema.

    Loaded by path rather than as ``plugins.memory.config_schema``: importing the
    package would execute ``plugins/memory/__init__.py``, which reaches into
    ``hermes_cli.config`` and wants yaml. The module is documented as pure data
    that imports nothing from the config/env layer, so a path load is both
    sufficient and what hermes's own loader does.
    """
    real_path = Path(os.environ["HERMES_REPO"]) / "plugins" / "memory" / "config_schema.py"
    if not real_path.is_file():
        pytest.skip(f"no config_schema.py under {real_path.parent}")

    spec = importlib.util.spec_from_file_location("_real_hermes_config_schema", real_path)
    real = importlib.util.module_from_spec(spec)
    # Registered before exec: the dataclasses there use PEP 604 annotations
    # (`str | None`), and dataclasses resolves those through
    # sys.modules[cls.__module__].
    sys.modules[spec.name] = real
    try:
        spec.loader.exec_module(real)
        schema = _load_schema(real)
    finally:
        sys.modules.pop(spec.name, None)
    assert isinstance(schema, real.ProviderConfigSchema)
    assert schema.name == "elephant"
    # The dashboard renders inline fields in the compact panel and hides the
    # rest behind the full-config modal; an empty inline set means a blank panel.
    assert schema.inline_fields()
    assert [f.key for f in schema.fields if f.is_secret] == ["token"]
