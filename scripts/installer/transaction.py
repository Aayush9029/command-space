import argparse
import json
import os
from pathlib import Path
import re
import shutil

BROWSERS = (
    "chromium",
    "google-chrome",
    "google-chrome-beta",
    "BraveSoftware/Brave-Browser",
    "microsoft-edge",
    "vivaldi",
)
DATA_ROOTS = (".config", ".local/share", ".local/state")


def copy_path(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
    elif source.is_dir():
        shutil.copytree(source, destination, symlinks=True)
    else:
        shutil.copy2(source, destination)


def managed_paths(home, project):
    locations = [
        ".local/share/super-space/bin", ".local/share/super-space/runtime",
        ".local/share/super-space/bundled-extensions",
        ".local/bin/super-space", ".local/bin/super-space-menu",
        ".config/systemd/user/super-space.service",
        ".local/share/applications/super-space.desktop",
        ".config/hypr/hyprland.lua", ".config/hypr/super-space.lua",
        ".config/omarchy/shell.json", ".config/omarchy/shell.super-space.tmp",
        ".config/omarchy/plugins/super-space.launcher",
        ".config/super-space/config.toml", ".local/state/super-space/backups",
        ".config/chromium-flags.conf", ".config/chromium-flags.conf.super-space.tmp",
        ".mozilla/native-messaging-hosts/com.superspace.bridge.json",
    ]
    for browser in BROWSERS:
        locations.append(f".config/{browser}/NativeMessagingHosts/com.superspace.bridge.json")
    for manifest in (project / "extensions").glob("*/package.json"):
        name = json.loads(manifest.read_text())["name"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
            raise ValueError("Invalid bundled extension name")
        locations.append(f".local/share/super-space/extensions/{name}")
    legacy = any((home / prefix / "command-space").exists() for prefix in DATA_ROOTS)
    if legacy:
        full_roots = [
            f"{prefix}/{name}"
            for prefix in DATA_ROOTS
            for name in ("command-space", "super-space")
        ]
        locations = [
            location for location in locations
            if not any(
                location == root or location.startswith(root + "/")
                for root in full_roots
            )
        ] + full_roots
    locations += [
        ".local/bin/command-space", ".local/bin/command-space-menu",
        ".config/systemd/user/command-space.service", ".config/systemd/user/command-space-dev.service",
        ".local/share/applications/command-space.desktop", ".config/hypr/command-space.lua",
        ".config/omarchy/plugins/command-space.launcher",
        ".mozilla/native-messaging-hosts/com.commandspace.bridge.json",
    ]
    for browser in BROWSERS:
        locations.append(f".config/{browser}/NativeMessagingHosts/com.commandspace.bridge.json")
    return list(dict.fromkeys(locations))


def save_snapshot(home, project, backup):
    snapshot = []
    for index, relative in enumerate(managed_paths(home, project)):
        source = home / relative
        if source.is_symlink() and relative not in [".local/bin/super-space", ".local/bin/command-space"]:
            raise ValueError(f"Managed installation path is a symlink: {source}")
        existed = source.exists() or source.is_symlink()
        if existed:
            copy_path(source, backup / str(index))
        snapshot.append({"path": str(source), "existed": existed, "index": index})
    (backup / "manifest.json").write_text(json.dumps(snapshot))


def restore_snapshot(backup):
    for entry in json.loads((backup / "manifest.json").read_text()):
        destination = Path(entry["path"])
        if destination.is_symlink() or destination.is_file():
            destination.unlink()
        elif destination.exists():
            shutil.rmtree(destination)
        if entry["existed"]:
            copy_path(backup / str(entry["index"]), destination)


def main():
    parser = argparse.ArgumentParser(description="Save or restore managed installer files.")
    parser.add_argument("mode", choices=("save", "restore"))
    parser.add_argument("backup", type=Path)
    parser.add_argument("project", type=Path)
    arguments = parser.parse_args()
    if arguments.mode == "save":
        save_snapshot(Path.home(), arguments.project, arguments.backup)
    else:
        restore_snapshot(arguments.backup)


if __name__ == "__main__":
    main()
