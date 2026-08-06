"""Tests for `hermes-elephant install` — the directory-drop workaround.

Hermes only discovers memory providers by scanning directories, so this
installer is the difference between a working provider and
`Plugin: NOT installed`. Everything it promises is checked here: what lands on
disk, that it can be re-run, that it targets the right profile, and that it
never eats a directory it did not create.
"""

from __future__ import annotations

import sys
import tomllib
from pathlib import Path

import pytest

from hermes_elephant import install

ADAPTER_ROOT = Path(__file__).resolve().parent.parent
PROVIDER_DIR = ADAPTER_ROOT / "hermes_elephant" / "provider"


@pytest.fixture
def home(tmp_path):
    return tmp_path / "hermes-home"


def test_install_lays_down_the_provider(home, capsys):
    assert install.main(["install", "--hermes-home", str(home)]) == 0
    target = home / "plugins" / "elephant"

    # The directory name is what hermes keys on: `memory.provider: elephant`,
    # `hermes elephant`, and the plugins/memory loader all use it. The import
    # package is hermes_elephant to dodge the unrelated `elephant` on PyPI.
    assert target.is_dir()
    # The installed tree IS the provider subpackage, plus our marker. A
    # directory boundary rather than an allowlist, so copy mode, --link mode
    # and the built wheel cannot disagree about what ships.
    expected = {p.name for p in PROVIDER_DIR.iterdir() if not p.name.startswith((".", "__pycache__"))}
    assert {p.name for p in target.iterdir()} == expected | {install.MARKER}
    assert "Installed the elephant memory provider" in capsys.readouterr().out


def test_installed_tree_carries_no_installer(home):
    install.main(["install", "--hermes-home", str(home)])
    # Hermes execs every *.py in a provider directory as a submodule so relative
    # imports resolve. The installer has no business running inside the agent.
    assert not (home / "plugins" / "elephant" / "install.py").exists()


def test_install_is_idempotent(home):
    assert install.main(["install", "--hermes-home", str(home)]) == 0
    stale = home / "plugins" / "elephant" / "leftover.py"
    stale.write_text("# from an older version", encoding="utf-8")

    assert install.main(["install", "--hermes-home", str(home)]) == 0
    # A reinstall replaces the tree rather than merging into it, so a file that
    # a previous version shipped cannot linger and get exec'd as a submodule.
    assert not stale.exists()


def test_install_refuses_to_clobber_a_foreign_directory(home, capsys):
    target = home / "plugins" / "elephant"
    target.mkdir(parents=True)
    (target / "mine.py").write_text("# hand-rolled", encoding="utf-8")

    assert install.main(["install", "--hermes-home", str(home)]) == 1
    assert (target / "mine.py").exists()
    assert "Refusing to overwrite" in capsys.readouterr().err

    assert install.main(["install", "--hermes-home", str(home), "--force"]) == 0
    assert not (target / "mine.py").exists()


def test_link_mode_points_at_the_source(home):
    assert install.main(["install", "--hermes-home", str(home), "--link"]) == 0
    target = home / "plugins" / "elephant"
    assert target.is_symlink()
    assert target.resolve() == PROVIDER_DIR


def test_uninstall_removes_only_our_own(home, capsys):
    install.main(["install", "--hermes-home", str(home)])
    assert install.main(["uninstall", "--hermes-home", str(home)]) == 0
    assert not (home / "plugins" / "elephant").exists()

    # Second run is a no-op, not an error — `uninstall` should be safe to script.
    assert install.main(["uninstall", "--hermes-home", str(home)]) == 0

    foreign = home / "plugins" / "elephant"
    foreign.mkdir(parents=True)
    assert install.main(["uninstall", "--hermes-home", str(home)]) == 1
    assert foreign.exists()
    assert "not created by this installer" in capsys.readouterr().err


def test_bare_invocation_installs(home):
    assert install.main(["--hermes-home", str(home)]) == 0
    assert (home / "plugins" / "elephant").is_dir()


def test_hermes_home_is_honoured_before_the_verb(home):
    # Regression: with an argparse subparser tree, --hermes-home declared on
    # both the top level and the subcommand meant the subparser's own None
    # default clobbered a value given first, silently installing to the real
    # $HERMES_HOME. Both orders must resolve to the same place.
    assert install.main(["--hermes-home", str(home), "install"]) == 0
    assert (home / "plugins" / "elephant").is_dir()


def test_cli_module_loads_the_way_hermes_loads_it(home):
    """Regression: `hermes elephant ...` was dead for every directory install.

    hermes registers a user-installed provider's package as a synthetic shell
    with no ``__file__`` and execs each ``*.py`` as a submodule before the
    package body runs (plugins/memory/__init__.py). Under that shell a
    parent-attribute import — ``from . import DEFAULT_URL`` — raises
    ``ImportError: ... (unknown location)``, so cli.py failed to load and
    ``discover_plugin_cli_commands()`` returned nothing, while plugin.yaml and
    the README advertised the subcommands. Shared names live in ``_shared.py``
    so the import is a submodule import, which resolves through the shell's
    ``__path__``.
    """
    import importlib.machinery
    import importlib.util

    install.main(["install", "--hermes-home", str(home)])
    target = home / "plugins" / "elephant"

    namespace = "_hermes_user_memory_probe"
    for name, locations in ((namespace, []), (f"{namespace}.elephant", [str(target)])):
        spec = importlib.machinery.ModuleSpec(name, None, is_package=True)
        spec.submodule_search_locations = locations
        sys.modules[name] = importlib.util.module_from_spec(spec)

    try:
        # Mirror the loader's submodule sweep: register and exec one module at
        # a time, in glob order. Registering them all up front would be a
        # different (and more forgiving) contract than hermes actually offers.
        for sub_file in sorted(target.glob("*.py")):
            if sub_file.name == "__init__.py":
                continue
            spec = importlib.util.spec_from_file_location(
                f"{namespace}.elephant.{sub_file.stem}", str(sub_file)
            )
            mod = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = mod
            if sub_file.stem == "config_schema":
                continue  # needs the hermes package; loaded by path elsewhere
            spec.loader.exec_module(mod)

        cli = sys.modules[f"{namespace}.elephant.cli"]
        assert callable(cli.register_cli)
        assert cli.DEFAULT_URL  # the parent-attribute import that used to fail
    finally:
        for name in list(sys.modules):
            if name.startswith(namespace):
                del sys.modules[name]


def test_status_reports_the_resolved_profile_not_the_env(home, monkeypatch, capsys):
    # --hermes-home must win over $HERMES_HOME, or `status` would cheerfully
    # describe a profile the other subcommands are not touching.
    monkeypatch.setenv("HERMES_HOME", "/somewhere/else")
    assert install.main(["status", "--hermes-home", str(home)]) == 0
    out = capsys.readouterr().out
    assert str(home) in out
    assert "/somewhere/else" not in out
    assert "installed:    no" in out

    install.main(["install", "--hermes-home", str(home)])
    install.main(["status", "--hermes-home", str(home)])
    assert "installed:    yes" in capsys.readouterr().out


def test_hermes_home_env_selects_the_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "work-profile"))
    assert install.main(["install"]) == 0
    assert (tmp_path / "work-profile" / "plugins" / "elephant").is_dir()


def test_caches_are_not_shipped(home):
    """Copying a whole directory is what makes the shipped set self-maintaining,
    but it also means anything sitting in that directory comes along. hermes
    execs every *.py in a plugin directory as a submodule, so a stale
    __pycache__ has no business being there."""
    cache = PROVIDER_DIR / "__pycache__"
    cache.mkdir(exist_ok=True)
    (cache / "cli.cpython-311.pyc").write_bytes(b"\x00")

    assert install.main(["install", "--hermes-home", str(home)]) == 0
    installed = home / "plugins" / "elephant"
    assert not (installed / "__pycache__").exists()
    assert not any(p.suffix == ".pyc" for p in installed.rglob("*"))


def test_install_verifies_the_discovery_contract(home, tmp_path, monkeypatch, capsys):
    """hermes classifies a provider directory by scanning the first 8KB of its
    __init__.py for MemoryProvider/register_memory_provider. A packaging gap
    should fail at install time, not surface later as `Plugin: NOT installed`."""
    fake_source = tmp_path / "provider"
    fake_source.mkdir()
    (fake_source / "__init__.py").write_text("# nothing hermes recognises\n", encoding="utf-8")
    monkeypatch.setattr(install, "_source_dir", lambda: fake_source)

    assert install.main(["install", "--hermes-home", str(home)]) == 1
    assert "does not identify itself as a memory provider" in capsys.readouterr().err
    # A failed install leaves nothing half-written behind.
    assert not (home / "plugins" / "elephant").exists()


def test_status_flags_a_stale_copy(home, monkeypatch, capsys):
    """Copying rather than symlinking means `pip install -U` leaves the profile
    running the old version. Nothing else would ever notice."""
    install.main(["install", "--hermes-home", str(home)])
    monkeypatch.setattr(install, "package_version", lambda: "9.9.9")

    install.main(["status", "--hermes-home", str(home)])
    out = capsys.readouterr().out
    assert "STALE" in out
    assert "9.9.9" in out


def test_entry_point_and_console_script_are_declared():
    """The entry point is what makes the install step redundant once upstream
    discovery lands; the console script is what performs it until then."""
    manifest = tomllib.loads((ADAPTER_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    entry_points = manifest["project"]["entry-points"]

    assert entry_points["hermes_agent.memory_providers"] == {
        "elephant": "hermes_elephant.provider"
    }
    # Joining the general group would make hermes's PluginManager import this in
    # every process and then fail on a context with no register_memory_provider.
    assert "hermes_agent.plugins" not in entry_points
    assert manifest["project"]["scripts"]["hermes-elephant"] == "hermes_elephant.install:main"
    # Stdlib-only is a promise to the hermes runtime, not an implementation note.
    assert manifest["project"]["dependencies"] == []
