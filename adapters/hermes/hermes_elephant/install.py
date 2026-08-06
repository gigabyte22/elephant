"""``hermes-elephant install`` — put the provider where hermes will find it.

hermes-agent discovers memory providers by scanning directories: the bundled
``plugins/memory/<name>/`` tree, and ``$HERMES_HOME/plugins/<name>/``. It does
*not* scan pip entry points (upstream issue #40101; PRs #18842 / #40644 /
#76567 are open against it). So ``pip install hermes-elephant`` alone leaves the
provider invisible — ``hermes memory status`` reports ``Plugin: NOT installed``.

This command closes that gap by copying the provider into
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
import os
import shutil
import sys
from pathlib import Path
from typing import List, Optional

from ._shared import TOKEN_ENV

PLUGIN_NAME = "elephant"

# The provider's runtime surface. Copied verbatim into the plugin directory.
#
# ``install.py`` is deliberately absent: hermes executes *every* ``*.py`` in a
# provider directory as a submodule so relative imports resolve
# (plugins/memory/__init__.py), and the installer has no business running inside
# the agent. Everything here is stdlib-only, which is why the plugin adds no
# dependency to the hermes runtime.
PLUGIN_FILES = (
    "__init__.py",
    "client.py",
    "_shared.py",
    "cli.py",
    "config_schema.py",
    "plugin.yaml",
    "README.md",
)

# Written into the installed directory so `uninstall` and re-`install` can tell
# our copy apart from a directory the user put there by hand.
MARKER = ".hermes-elephant"


def hermes_home() -> Path:
    """The active hermes profile root.

    ``HERMES_HOME`` is how hermes itself scopes profiles, so honouring it means
    ``HERMES_HOME=~/.hermes-work hermes-elephant install`` targets that profile
    rather than the default one.
    """
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def plugin_dir(home: Optional[Path] = None) -> Path:
    return (home or hermes_home()) / "plugins" / PLUGIN_NAME


def _source_dir() -> Path:
    return Path(__file__).resolve().parent


def _is_ours(target: Path) -> bool:
    return (target / MARKER).exists() or target.is_symlink()


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
        if target.is_symlink() or target.is_file():
            target.unlink()
        else:
            shutil.rmtree(target)

    target.parent.mkdir(parents=True, exist_ok=True)

    if link:
        # Dev mode: the symlink points at the installed package, so edits to the
        # source show up in hermes without reinstalling. install.py comes along
        # for the ride and hermes will exec it as a submodule; it is inert on
        # import, which is why all of its logic lives under main().
        target.symlink_to(source, target_is_directory=True)
        print(f"Linked {target} -> {source}")
    else:
        target.mkdir(parents=True)
        missing: List[str] = []
        for name in PLUGIN_FILES:
            src = source / name
            if not src.exists():
                missing.append(name)
                continue
            shutil.copy2(src, target / name)
        if missing:
            print(f"warning: missing from the installed package: {', '.join(missing)}", file=sys.stderr)
        (target / MARKER).write_text("installed by hermes-elephant\n", encoding="utf-8")
        print(f"Installed the elephant memory provider to {target}")

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
    if target.is_symlink():
        target.unlink()
    else:
        shutil.rmtree(target)
    print(f"Removed {target}")
    return 0


def _status(target: Path) -> int:
    # target is <home>/plugins/elephant, so its grandparent is the profile root
    # we actually resolved — which is not $HERMES_HOME when --hermes-home is set.
    print(f"profile root: {target.parent.parent}")
    print(f"plugin dir:   {target}")
    if target.is_symlink():
        print(f"installed:    yes (symlink -> {target.resolve()})")
    elif target.is_dir():
        kind = "yes" if _is_ours(target) else "yes (not created by this installer)"
        print(f"installed:    {kind}")
    else:
        print("installed:    no — run `hermes-elephant install`")
    token = os.environ.get(TOKEN_ENV)
    print(f"token env:    {'set' if token else 'unset (run `hermes memory setup`)'}")
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
        help="target profile root (default: $HERMES_HOME, else ~/.hermes)",
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
    command = args.command
    target = plugin_dir(args.hermes_home)

    if command == "install":
        return _install(target, link=args.link, force=args.force)
    if command == "uninstall":
        return _uninstall(target)
    return _status(target)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
