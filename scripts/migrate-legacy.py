import json
from pathlib import Path
import re
import shutil
import sys

home = Path.home()
old = "command-space"
new = "super-space"
roots = [home / prefix / old for prefix in (".config", ".local/share", ".local/state")]


def present(path):
    return path.exists() or path.is_symlink()


def validate():
    for source in roots:
        if not present(source):
            continue
        destination = source.with_name(new)
        if source.is_symlink() or not source.is_dir():
            raise ValueError(f"Legacy installation directory must be a real directory: {source}")
        if present(destination) and (destination.is_symlink() or not destination.is_dir() or any(destination.iterdir())):
            raise ValueError(f"Both launcher directories contain data. Resolve the conflict before installing: {source} and {destination}")


def migrate():
    validate()
    if not any(present(source) for source in roots) and not (home / ".config/hypr/command-space.lua").exists():
        return
    for source in roots:
        if not source.exists():
            continue
        destination = source.with_name(new)
        if destination.exists():
            destination.rmdir()
        source.rename(destination)
    extensions = home / ".local/share" / new / "extensions"
    for marker in extensions.glob(f"*/.{old}-source"):
        if marker.is_symlink() or marker.parent.is_symlink() or extensions.is_symlink():
            raise ValueError(f"Extension source marker must not be a symlink: {marker}")
        destination = marker.with_name(f".{new}-source")
        if present(destination):
            raise ValueError(f"Both extension source markers exist: {marker.parent}")
        source = marker.read_text()
        for prefix in [".local/share", "Developer"]:
            managed = str(home / prefix / old)
            if source == managed or source.startswith(managed + "/"):
                source = str(home / prefix / new) + source[len(managed):]
                break
        destination.write_text(source)
        marker.unlink()
    main = home / ".config/hypr/hyprland.lua"
    content = main.read_text()
    content = re.sub(r'^[ \t]*require\([\"\']hypr\.command-space[\"\']\)[ \t]*;?[ \t]*\n?', '', content, flags=re.MULTILINE)
    main.write_text(content)
    shell = home / ".config/omarchy/shell.json"
    if shell.exists():
        settings = json.loads(shell.read_text())
        for widgets in settings.get("bar", {}).get("layout", {}).values():
            if isinstance(widgets, list):
                for widget in widgets:
                    if isinstance(widget, dict) and widget.get("id") == f"{old}.launcher":
                        widget["id"] = f"{new}.launcher"
        shell.write_text(json.dumps(settings, indent=2) + "\n")


def cleanup():
    extensions = home / ".local/share" / new / "extensions"
    for bundle in extensions.glob(f"*/.{old}-*.cjs"):
        if bundle.parent.is_symlink() or extensions.is_symlink():
            raise ValueError(f"Extension directory must not be a symlink: {bundle.parent}")
        bundle.unlink()
    locations = [
        f".local/share/{new}/bin/{old}",
        f".local/bin/{old}", f".local/bin/{old}-menu",
        f".config/systemd/user/{old}.service", f".config/systemd/user/{old}-dev.service",
        f".local/share/applications/{old}.desktop", f".config/hypr/{old}.lua",
        f".config/omarchy/plugins/{old}.launcher",
    ]
    for relative in locations:
        item = home / relative
        if item.is_symlink() or item.is_file():
            item.unlink()
        elif item.exists():
            shutil.rmtree(item)


if sys.argv[1] == "check":
    validate()
elif sys.argv[1] == "migrate":
    migrate()
elif sys.argv[1] == "cleanup":
    cleanup()
elif sys.argv[1] == "clear-cache":
    cache = home / ".cache" / old
    if cache.is_symlink():
        cache.unlink()
    elif cache.exists():
        shutil.rmtree(cache)
else:
    raise ValueError("Unknown migration operation")
