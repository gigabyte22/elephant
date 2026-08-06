"""``hermes-elephant install`` — put the provider where hermes will find it.

hermes-agent discovers memory providers by scanning directories: the bundled
``plugins/memory/<name>/`` tree, and ``$HERMES_HOME/plugins/<name>/``. It does
*not* scan pip entry points (upstream issue #40101; PRs #18842 / #40644 /
#76567 are open against it). So ``pip install hermes-elephant`` alone leaves the
provider invisible — ``hermes memory status`` reports ``Plugin: NOT installed``.

This command closes that gap by copying :mod:`hermes_elephant.provider` into
``$HERMES_HOME/plugins/elephant/``, which is the path stock hermes already
supports. It is the same two-step shape the Memori provider ships
(``pip install hermes-memori && hermes-memori install``).

Once entry-point discovery lands upstream this becomes redundant — the
``hermes_agent.memory_providers`` entry point in our pyproject already declares
the provider — but it stays harmless and keeps older hermes installs working.

Usage::

    hermes-elephant install          # copy into $HERMES_HOME/plugins/elephant
    hermes-elephant install --link   # symlink instead (edits show up live)
    hermes-elephant status
    hermes-elephant uninstall
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from .provider._shared import TOKEN_ENV

PLUGIN_NAME = "elephant"

# Written into the installed directory so `uninstall` and re-`install` can tell
# our copy apart from a directory the user put there by hand, and so `status`
# can spot a copy left behind by an earlier version of the package.
MARKER = ".hermes-elephant"

# Never copied into the plugin directory: hermes execs every *.py there as a
# submodule, and caches are not source.
_IGNORED = shutil.ignore_patterns("__pycache__", "*.pyc", ".*")


def package_version() -> str:
    """The installed distribution's version, or ``"unknown"``.

    Recorded in the marker so ``status`` can tell you the copy in your profile
    has fallen behind the package — the one real cost of copying rather than
    symlinking, and otherwise completely invisible.
    """
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("hermes-elephant")
        except PackageNotFoundError:
            return "unknown"
    except Exception:
        return "unknown"


def hermes_home() -> Path:
    """The active hermes profile root.

    Mirrors ``hermes_constants.get_hermes_home()``, including its Windows
    branch — installing to ``~/.hermes`` on a machine where hermes actually
    reads ``%LOCALAPPDATA%\\hermes`` would drop the provider somewhere nothing
    scans and then report success. Prefer hermes's own resolver when it is
    importable (we are installed into its venv, so usually it is); the fallback
    exists for a bare ``pip install`` outside that venv.
    """
    override = os.environ.get("HERMES_HOME")
    if override:
        return Path(override)
    try:
        from hermes_constants import get_hermes_home  # type: ignore[import-not-found]

        return Path(get_hermes_home())
    except Exception:
        pass
    if sys.platform == "win32":
        local_appdata = os.environ.get("LOCALAPPDATA")
        if local_appdata:
            return Path(local_appdata) / "hermes"
    return Path.home() / ".hermes"


def plugin_dir(home: Optional[Path] = None) -> Path:
    return (home or hermes_home()) / "plugins" / PLUGIN_NAME


def _source_dir() -> Path:
    """The provider subpackage — exactly what gets installed.

    A directory boundary rather than a filename allowlist, so copy mode, link
    mode, and the built wheel can never disagree about what ships.
    """
    return Path(__file__).resolve().parent / "provider"


def _read_marker(target: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads((target / MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _is_ours(target: Path) -> bool:
    """Whether this installer created *target*.

    A symlink counts only when it points at our own package. Treating every
    symlink as ours would let ``uninstall`` silently unlink one the user made
    pointing at their own provider tree.
    """
    if (target / MARKER).exists():
        return True
    if target.is_symlink():
        try:
            return target.resolve() == _source_dir()
        except OSError:
            return False
    return False


def _remove(target: Path) -> None:
    if target.is_symlink() or target.is_file():
        target.unlink()
    else:
        shutil.rmtree(target)


def _verify(target: Path) -> Optional[str]:
    """Check the installed tree against hermes's discovery contract.

    hermes classifies a directory as a memory provider by reading the first
    8 KiB of its ``__init__.py`` and looking for ``MemoryProvider`` or
    ``register_memory_provider`` (``plugins/memory/__init__.py``). Asserting
    that here means a packaging gap fails loudly at install time instead of
    surfacing later as an unexplained ``Plugin: NOT installed``, and it pins an
    otherwise invisible upstream constraint: pushing those markers past the
    window with a longer module docstring would break discovery silently.
    """
    init_file = target / "__init__.py"
    if not init_file.is_file():
        return f"{init_file} is missing — the installed tree is not a provider."
    try:
        head = init_file.read_text(encoding="utf-8", errors="replace")[:8192]
    except OSError as err:
        return f"could not read {init_file}: {err}"
    if "MemoryProvider" not in head and "register_memory_provider" not in head:
        return (
            f"{init_file} does not identify itself as a memory provider within the "
            "first 8KB — hermes will not discover it."
        )
    return None


def _install(target: Path, *, link: bool, force: bool) -> int:
    source = _source_dir()

    if target.exists() or target.is_symlink():
        if not _is_ours(target) and not force:
            print(
                f"{target} already exists and was not created by this installer.\n"
                "Refusing to overwrite it — re-run with --force if that is what you want.",
                file=sys.stderr,
            )
            return 1
        _remove(target)

    target.parent.mkdir(parents=True, exist_ok=True)

    if link:
        # Dev mode: edits to the source show up in hermes without reinstalling.
        # The linked tree is the same directory copy mode ships, so this is a
        # faithful rehearsal rather than a different file set.
        target.symlink_to(source, target_is_directory=True)
        print(f"Linked {target} -> {source}")
    else:
        shutil.copytree(source, target, ignore=_IGNORED)

    problem = _verify(target)
    if problem:
        print(f"Install failed: {problem}", file=sys.stderr)
        if not link:
            _remove(target)
        return 1

    if not link:
        (target / MARKER).write_text(
            json.dumps({"version": package_version(), "source": str(source)}, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"Installed the elephant memory provider ({package_version()}) to {target}")

    print(
        "\nNext:\n"
        "  hermes memory setup      # select 'elephant', set the service token\n"
        "  hermes memory status     # expect: Plugin: installed\n"
        "  hermes elephant status   # check the service is reachable"
    )
    return 0


def _uninstall(target: Path) -> int:
    if not target.exists() and not target.is_symlink():
        print(f"Nothing to remove at {target}")
        return 0
    if not _is_ours(target):
        print(
            f"{target} was not created by this installer — leaving it alone.",
            file=sys.stderr,
        )
        return 1
    _remove(target)
    print(f"Removed {target}")
    return 0


def _status(target: Path) -> int:
    # target is <home>/plugins/elephant, so its grandparent is the profile root
    # we actually resolved — which is not $HERMES_HOME when --hermes-home is set.
    print(f"profile root: {target.parent.parent}")
    print(f"plugin dir:   {target}")
    print(f"package:      {package_version()}")

    if target.is_symlink():
        print(f"installed:    yes (symlink -> {target.resolve()})")
    elif target.is_dir():
        marker = _read_marker(target)
        if marker is None:
            print("installed:    yes (not created by this installer)")
        elif marker.get("version") != package_version():
            print(
                f"installed:    STALE — copy is {marker.get('version')}, "
                f"package is {package_version()}; re-run `hermes-elephant install`"
            )
        else:
            print("installed:    yes")
    else:
        print("installed:    no — run `hermes-elephant install`")

    print(f"token env:    {'set' if os.environ.get(TOKEN_ENV) else 'unset (run `hermes memory setup`)'}")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    # One flat parser rather than subparsers. With subparsers, declaring
    # --hermes-home on both the top level and each subcommand (so that both
    # placements are accepted) makes the subparser's own `None` default
    # overwrite a value given before the verb — `hermes-elephant
    # --hermes-home /x install` would silently install to $HERMES_HOME. Three
    # verbs and three flags do not need the machinery that introduces that.
    parser = argparse.ArgumentParser(
        prog="hermes-elephant",
        description="Install the elephant memory provider into a hermes-agent profile.",
    )
    parser.add_argument(
        "command",
        nargs="?",
        default="install",
        choices=("install", "uninstall", "status"),
        help="what to do (default: install)",
    )
    parser.add_argument(
        "--hermes-home",
        type=Path,
        default=None,
        help="target profile root (default: $HERMES_HOME, else hermes's own default)",
    )
    parser.add_argument(
        "--link",
        action="store_true",
        help="install: symlink the package instead of copying (for development)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="install: overwrite an existing directory this installer did not create",
    )

    args = parser.parse_args(argv)
    target = plugin_dir(args.hermes_home)

    if args.command == "install":
        return _install(target, link=args.link, force=args.force)
    if args.command == "uninstall":
        return _uninstall(target)
    return _status(target)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
