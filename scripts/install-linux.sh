#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$HOME/.cargo/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"

fail() {
  printf 'Command Space installation: %s\n' "$*" >&2
  exit 1
}

for dependency in bash bun python3 flock rsync systemctl systemd-run update-desktop-database dirname install mkdir mv ln chmod cat sleep mktemp rm; do
  command -v "$dependency" >/dev/null 2>&1 || fail "Missing required command: $dependency. Install it and retry."
done
project_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$project_dir"
bun_version=$(bun --version) || fail 'Could not run Bun. Check the configured Bun installation.'
if [[ ! "$bun_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  fail "Bun 1.4.2 or newer is required; found $bun_version."
fi
if (( BASH_REMATCH[1] < 1 || (BASH_REMATCH[1] == 1 && BASH_REMATCH[2] < 4) || (BASH_REMATCH[1] == 1 && BASH_REMATCH[2] == 4 && BASH_REMATCH[3] < 2) )); then
  fail "Bun 1.4.2 or newer is required; found $bun_version."
fi
python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))' || fail 'Python 3.12 or newer is required.'
systemctl --user show-environment >/dev/null || fail 'The systemd user session is unavailable. Run the installer as your desktop user.'
[[ -f "$HOME/.config/hypr/hyprland.lua" ]] || fail "Omarchy's Hyprland Lua configuration was not found."

for setting in XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME; do
  case "$setting" in
    XDG_CONFIG_HOME) expected="$HOME/.config" ;;
    XDG_DATA_HOME) expected="$HOME/.local/share" ;;
    XDG_STATE_HOME) expected="$HOME/.local/state" ;;
  esac
  [[ -z "${!setting:-}" || "${!setting}" == "$expected" ]] || fail "$setting must use $expected for Omarchy desktop integration."
done

export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"
mkdir -p "$HOME/.cache/command-space"
exec 9> "$HOME/.cache/command-space/install.lock"
flock -n 9 || fail 'Another Command Space installation is running.'

profile=${1:---release}
case "$profile" in --prebuilt|--debug|--release) ;; *) fail "Unknown installation mode: $profile" ;; esac
if [[ "$profile" != --prebuilt ]]; then
  for dependency in cargo nice; do
    command -v "$dependency" >/dev/null 2>&1 || fail "Missing required command: $dependency. Install Rust and retry."
  done
fi
for file in runtime/host.mjs runtime/bun.lock scripts/start-daemon.sh; do
  [[ -f "$file" ]] || fail "The package is incomplete: missing $file."
done
[[ -d extensions ]] || fail 'The package is incomplete: missing bundled extensions.'
if [[ "$profile" == --prebuilt ]]; then
  binary=bin/command-space
  [[ -x "$binary" ]] || fail 'The package executable is missing or not executable.'
  [[ -d runtime/node_modules ]] || fail 'The package is incomplete: missing runtime dependencies.'
  "$binary" --version >/dev/null || fail 'The packaged executable cannot run on this system.'
elif [[ "$profile" == --debug ]]; then
  nice -n 10 cargo build --bin command-space
  binary=target/debug/command-space
else
  nice -n 10 cargo build --release --bin command-space
  binary=target/release/command-space
fi
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/command-space"
transaction=$(mktemp -d)
transaction_ready=false
service_active=false
service_enabled=false
dev_active=false
systemctl --user is-active --quiet command-space.service && service_active=true
systemctl --user is-enabled --quiet command-space.service && service_enabled=true
systemctl --user is-active --quiet command-space-dev.service && dev_active=true

installation_state() {
  python3 - "$1" "$transaction" "$project_dir" <<'PYTHON'
import json
import os
from pathlib import Path
import re
import shutil
import sys

mode, temporary, project = sys.argv[1:]
backup = Path(temporary)
home = Path.home()

def copy(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
    elif source.is_dir():
        shutil.copytree(source, destination, symlinks=True)
    else:
        shutil.copy2(source, destination)

if mode == "save":
    locations = [
        ".local/share/command-space/bin", ".local/share/command-space/runtime",
        ".local/share/command-space/bundled-extensions",
        ".local/bin/command-space", ".local/bin/command-space-menu",
        ".config/systemd/user/command-space.service",
        ".local/share/applications/command-space.desktop",
        ".config/hypr/hyprland.lua", ".config/hypr/command-space.lua",
        ".config/omarchy/shell.json", ".config/omarchy/shell.command-space.tmp",
        ".config/omarchy/plugins/command-space.launcher",
        ".config/command-space/config.toml", ".local/state/command-space/backups",
        ".config/chromium-flags.conf", ".config/chromium-flags.conf.command-space.tmp",
        ".mozilla/native-messaging-hosts/com.commandspace.bridge.json",
    ]
    for browser in ["chromium", "google-chrome", "google-chrome-beta", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi"]:
        locations.append(f".config/{browser}/NativeMessagingHosts/com.commandspace.bridge.json")
    for manifest in Path(project, "extensions").glob("*/package.json"):
        name = json.loads(manifest.read_text())["name"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
            raise ValueError("Invalid bundled extension name")
        locations.append(f".local/share/command-space/extensions/{name}")
    snapshot = []
    for index, relative in enumerate(dict.fromkeys(locations)):
        source = home / relative
        if source.is_symlink() and relative != ".local/bin/command-space":
            raise ValueError(f"Managed installation path is a symlink: {source}")
        existed = source.exists() or source.is_symlink()
        if existed:
            copy(source, backup / str(index))
        snapshot.append({"path": str(source), "existed": existed, "index": index})
    (backup / "manifest.json").write_text(json.dumps(snapshot))
else:
    for entry in json.loads((backup / "manifest.json").read_text()):
        destination = Path(entry["path"])
        if destination.is_symlink() or destination.is_file():
            destination.unlink()
        elif destination.exists():
            shutil.rmtree(destination)
        if entry["existed"]:
            copy(backup / str(entry["index"]), destination)
PYTHON
}

finish_install() {
  status=$?
  trap - EXIT INT TERM
  if (( status != 0 )) && [[ "$transaction_ready" == true ]]; then
    printf 'Installation failed. Restoring the previous installation.\n' >&2
    systemctl --user stop command-space.service >/dev/null 2>&1 || true
    if installation_state restore; then
      systemctl --user daemon-reload || true
      if [[ "$service_enabled" == true ]]; then
        systemctl --user enable command-space.service >/dev/null 2>&1 || true
      else
        systemctl --user disable command-space.service >/dev/null 2>&1 || true
      fi
      if [[ "$service_active" == true ]]; then
        systemctl --user restart command-space.service || printf 'Could not restart the restored launcher.\n' >&2
      fi
      if [[ "$dev_active" == true ]]; then
        systemctl --user restart command-space-dev.service || true
      fi
      if systemctl --user show-environment | python3 -c 'import sys; sys.exit(not any(line.startswith("HYPRLAND_INSTANCE_SIGNATURE=") for line in sys.stdin))'; then
        systemd-run --user --quiet --wait --pipe --collect hyprctl reload config-only >/dev/null 2>&1 || true
        systemd-run --user --quiet --wait --pipe --collect /usr/share/omarchy/bin/omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
      fi
      update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
    else
      printf 'Recovery files remain at %s. Restore failed; do not delete this directory.\n' "$transaction" >&2
      exit "$status"
    fi
  fi
  rm -rf "$transaction"
  exit "$status"
}
trap finish_install EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
installation_state save
transaction_ready=true
if [[ "$service_active" == true ]]; then
  systemctl --user stop command-space.service
fi
mkdir -p "$install_root/bin" "$install_root/runtime" "$HOME/.local/bin" "$HOME/.config/systemd/user" "$HOME/.local/share/applications"
install -m 755 "$binary" "$install_root/bin/command-space.new"
mv "$install_root/bin/command-space.new" "$install_root/bin/command-space"
rsync -a --delete --exclude node_modules --exclude tests runtime/ "$install_root/runtime/"
if [[ "$profile" == --prebuilt ]]; then
  rsync -a --delete runtime/node_modules/ "$install_root/runtime/node_modules/"
else
  bun install --cwd "$install_root/runtime" --production --frozen-lockfile --ignore-scripts
fi
ln -sfn "$install_root/bin/command-space" "$HOME/.local/bin/command-space"
install -m 755 scripts/start-daemon.sh "$install_root/bin/start-daemon"
cat > "$HOME/.local/bin/command-space-menu" <<'SH'
#!/bin/sh
exec "$HOME/.local/bin/command-space" "${@:-toggle}"
SH
chmod +x "$HOME/.local/bin/command-space-menu"
cat > "$HOME/.config/systemd/user/command-space.service" <<'SERVICE'
[Unit]
Description=Command Space launcher
After=graphical-session-pre.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=%h/.local/share/command-space/bin/start-daemon
Environment=PATH=%h/.bun/bin:%h/.local/bin:%h/.local/share/mise/shims:%h/.cargo/bin:/usr/share/omarchy/bin:/usr/local/bin:/usr/bin
Restart=on-failure
RestartSec=2

[Install]
WantedBy=graphical-session.target
SERVICE
cat > "$HOME/.local/share/applications/command-space.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Command Space
Comment=Search applications, Omarchy commands, and extensions
Exec=$HOME/.local/bin/command-space %u
Icon=system-search
Terminal=false
NoDisplay=true
Categories=Utility;
MimeType=x-scheme-handler/command-space;x-scheme-handler/rustcast;x-scheme-handler/raycast;x-scheme-handler/com.raycast;
StartupWMClass=command-space
DESKTOP
systemctl --user daemon-reload
"$HOME/.local/bin/command-space" integration apply
mkdir -p "$install_root/bundled-extensions"
rsync -a --delete --exclude node_modules --exclude .git extensions/ "$install_root/bundled-extensions/"
for bundled in "$install_root/bundled-extensions"/*; do
  [[ -f "$bundled/package.json" ]] || continue
  "$HOME/.local/bin/command-space" extension install "$bundled" --replace
done
systemctl --user stop command-space-dev.service 2>/dev/null || true
systemctl --user restart command-space.service
ready=false
for attempt in {1..300}; do
  if "$HOME/.local/bin/command-space" ping >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.1
done
if [[ $ready != true ]]; then
  systemctl --user status command-space.service --no-pager
  exit 1
fi
update-desktop-database "$HOME/.local/share/applications"
printf 'Command Space is installed. Use Super+Space to open it.\n'
