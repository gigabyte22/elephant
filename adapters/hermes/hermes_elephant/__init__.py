"""Elephant memory provider for hermes-agent.

The provider itself lives in :mod:`hermes_elephant.provider`, which is exactly
the directory hermes installs and loads — copy mode, ``--link`` mode, and the
built wheel are the same set of files by construction, with no allowlist to
keep in sync. The installer stays out here so hermes never execs it (the
provider loader runs every ``*.py`` in the plugin directory as a submodule).

Re-exported here so ``from hermes_elephant import ElephantMemoryProvider``
keeps working; the entry point points at ``hermes_elephant.provider``.
"""

from .provider import ElephantMemoryProvider, register

__all__ = ["ElephantMemoryProvider", "register"]
