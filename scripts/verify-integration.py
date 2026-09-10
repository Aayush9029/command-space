#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess


project = Path(__file__).resolve().parent.parent
home = Path.home()
binary = home / ".local/share/super-space/bin/super-space"
hyprland = home / ".config/hypr/hyprland.lua"
shell = home / ".config/omarchy/shell.json"
retained = [home / ".config/super-space/config.toml", home / ".local/share/super-space/background.json"]
retained.extend((home / ".local/share/super-space/extension-data").glob("*/storage.json"))
snapshots = {path: path.read_bytes() for path in retained if path.exists()}
browser_flags = home / ".config/chromium-flags.conf"
browser_before = browser_flags.read_text()
bridge_path = str(home / ".local/share/super-space/runtime/browser-extension")
chromium_host = home / ".config/chromium/NativeMessagingHosts/com.superspace.bridge.json"
firefox_host = home / ".mozilla/native-messaging-hosts/com.superspace.bridge.json"
installed = sorted(path.name for path in (home / ".local/share/super-space/extensions").iterdir())


def widget_ids():
    layout = json.loads(shell.read_text())["bar"]["layout"]
    return [entry["id"] for group in layout.values() if isinstance(group, list) for entry in group]


try:
    subprocess.run([str(binary), "integration", "uninstall"], check=True)
    assert not (home / ".config/systemd/user/super-space.service").exists()
    assert not (home / ".local/bin/super-space").exists()
    assert 'require("hypr.super-space")' not in hyprland.read_text()
    assert "super-space.launcher" not in widget_ids()
    assert "omarchy.menu" in widget_ids()
    assert bridge_path not in browser_flags.read_text()
    assert not chromium_host.exists()
    assert not firefox_host.exists()
    assert all(path.read_bytes() == value for path, value in snapshots.items())
    assert sorted(path.name for path in (home / ".local/share/super-space/extensions").iterdir()) == installed
finally:
    environment = {**os.environ, "PATH": f"{home}/.cargo/bin:{home}/.local/share/mise/shims:{os.environ['PATH']}"}
    subprocess.run(["bash", "scripts/install-linux.sh"], cwd=project, env=environment, check=True)

assert browser_flags.read_text() == browser_before
assert bridge_path in browser_flags.read_text()
assert chromium_host.exists() and firefox_host.exists()
assert "super-space.launcher" in widget_ids()
assert hyprland.read_text().count('require("hypr.super-space")') == 1
assert all(path.read_bytes() == value for path, value in snapshots.items())
subprocess.run([str(binary), "ping"], check=True)
subprocess.run(["systemctl", "--user", "is-active", "super-space"], check=True)
print("Integration uninstall and reinstall passed; settings and extension data were preserved.")
