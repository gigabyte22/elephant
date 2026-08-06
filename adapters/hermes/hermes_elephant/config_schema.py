"""Elephant's declared config surface — rendered by hermes's generic panel.

hermes loads this file *by path* and never as part of the package (see
``plugins/memory/config_schema.py``): provider ``__init__.py`` files pull in the
agent runtime, which must not load into the web server. So the ``plugins.memory``
import below resolves inside a hermes process and nowhere else — importing
``hermes_elephant.config_schema`` standalone is expected to fail, and nothing in
this package does it.

Only the fields worth a dashboard control live here. The full set of knobs stays
in ``$HERMES_HOME/elephant.json``; see ``get_config_schema()`` in ``__init__.py``
for what the ``hermes memory setup`` wizard prompts for.
"""

from plugins.memory.config_schema import (
    KIND_NUMBER,
    KIND_SECRET,
    KIND_TEXT,
    ProviderConfigSchema,
    ProviderField,
)

CONFIG_SCHEMA = ProviderConfigSchema(
    name="elephant",
    label="Elephant",
    docs_url="https://github.com/kainappsinc/elephant/tree/main/adapters/hermes",
    fields=(
        ProviderField(
            key="token",
            label="Service token",
            kind=KIND_SECRET,
            env_key="ELEPHANT_SERVICE_TOKEN",
            description="Bearer token for the elephant service.",
            info="Must match MEMORY_SERVICE_TOKEN in the service's .env (minimum 8 characters).",
            placeholder="Enter the elephant service token",
            inline=True,
        ),
        ProviderField(
            key="url",
            label="Service URL",
            kind=KIND_TEXT,
            default="http://127.0.0.1:18790",
            description="Where the elephant service is listening.",
            info=(
                "Elephant binds to 127.0.0.1 by default. If you point this at a remote host, "
                "put the service behind TLS — the bearer token is its only authentication."
            ),
            env_fallbacks=("ELEPHANT_URL",),
            inline=True,
        ),
        ProviderField(
            key="agent_id",
            label="Agent ID",
            kind=KIND_TEXT,
            default="hermes",
            description="Stamped on every write and boosted at recall.",
            inline=True,
        ),
        ProviderField(
            key="auto_recall_limit",
            label="Recall limit",
            kind=KIND_NUMBER,
            default="8",
            description="Maximum items injected into the prompt per turn.",
            inline=True,
        ),
        ProviderField(
            key="project_id",
            label="Project ID",
            kind=KIND_TEXT,
            description="Optional project scope. Research notes require one.",
            group="Scope",
        ),
        ProviderField(
            key="user_id",
            label="User ID",
            kind=KIND_TEXT,
            description="Optional user scope. Leave empty for shared memory.",
            group="Scope",
        ),
    ),
)
