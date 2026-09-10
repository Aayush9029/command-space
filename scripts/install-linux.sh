#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:$HOME/.local/bin:$HOME/.cargo/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"

fail() {
  printf 'Super Space installation: %s\n' "$*" >&2
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
mkdir -p "$HOME/.cache/super-space"
exec 9> "$HOME/.cache/super-space/install.lock"
flock -n 9 || fail 'Another Super Space installation is running.'

if [[ -d "$HOME/.cache/command-space" ]]; then
  exec 8> "$HOME/.cache/command-space/install.lock"
  flock -n 8 || fail 'Another legacy launcher installation is running.'
fi
python3 scripts/migrate-legacy.py check

profile=${1:---release}
case "$profile" in --prebuilt|--debug|--release) ;; *) fail "Unknown installation mode: $profile" ;; esac
if [[ "$profile" != --prebuilt ]]; then
  for dependency in cargo nice; do
    command -v "$dependency" >/dev/null 2>&1 || fail "Missing required command: $dependency. Install Rust and retry."
  done
fi
for file in runtime/host.mjs runtime/bun.lock scripts/start-daemon.sh scripts/migrate-legacy.py; do
  [[ -f "$file" ]] || fail "The package is incomplete: missing $file."
done
[[ -d extensions ]] || fail 'The package is incomplete: missing bundled extensions.'
if [[ "$profile" == --prebuilt ]]; then
  binary=bin/super-space
  [[ -x "$binary" ]] || fail 'The package executable is missing or not executable.'
  [[ -d runtime/node_modules ]] || fail 'The package is incomplete: missing runtime dependencies.'
  "$binary" --version >/dev/null || fail 'The packaged executable cannot run on this system.'
elif [[ "$profile" == --debug ]]; then
  nice -n 10 cargo build --bin super-space
  binary=target/debug/super-space
else
  nice -n 10 cargo build --release --bin super-space
  binary=target/release/super-space
fi
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/super-space"
transaction=$(mktemp -d)
transaction_ready=false
services_stopped=false
service_active=false
service_enabled=false
dev_active=false
legacy_active=false
legacy_enabled=false
legacy_dev_active=false
legacy_dev_enabled=false
systemctl --user is-active --quiet command-space.service && legacy_active=true
systemctl --user is-enabled --quiet command-space.service && legacy_enabled=true
systemctl --user is-active --quiet command-space-dev.service && legacy_dev_active=true
systemctl --user is-enabled --quiet command-space-dev.service && legacy_dev_enabled=true
systemctl --user is-active --quiet super-space.service && service_active=true
systemctl --user is-enabled --quiet super-space.service && service_enabled=true
systemctl --user is-active --quiet super-space-dev.service && dev_active=true

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
    for browser in ["chromium", "google-chrome", "google-chrome-beta", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi"]:
        locations.append(f".config/{browser}/NativeMessagingHosts/com.superspace.bridge.json")
    for manifest in Path(project, "extensions").glob("*/package.json"):
        name = json.loads(manifest.read_text())["name"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
            raise ValueError("Invalid bundled extension name")
        locations.append(f".local/share/super-space/extensions/{name}")
    legacy = any((home / prefix / "command-space").exists() for prefix in [".config", ".local/share", ".local/state"])
    if legacy:
        full_roots = [f"{prefix}/{name}" for prefix in [".config", ".local/share", ".local/state"] for name in ["command-space", "super-space"]]
        locations = [location for location in locations if not any(location == root or location.startswith(root + "/") for root in full_roots)] + full_roots
    locations += [
        ".local/bin/command-space", ".local/bin/command-space-menu",
        ".config/systemd/user/command-space.service", ".config/systemd/user/command-space-dev.service",
        ".local/share/applications/command-space.desktop", ".config/hypr/command-space.lua",
        ".config/omarchy/plugins/command-space.launcher",
        ".mozilla/native-messaging-hosts/com.commandspace.bridge.json",
    ]
    for browser in ["chromium", "google-chrome", "google-chrome-beta", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi"]:
        locations.append(f".config/{browser}/NativeMessagingHosts/com.commandspace.bridge.json")
    snapshot = []
    for index, relative in enumerate(dict.fromkeys(locations)):
        source = home / relative
        if source.is_symlink() and relative not in [".local/bin/super-space", ".local/bin/command-space"]:
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

restore_services() {
  systemctl --user daemon-reload || true
  for unit in super-space.service command-space.service command-space-dev.service; do
    case "$unit" in
      super-space.service) enabled=$service_enabled; active=$service_active ;;
      command-space.service) enabled=$legacy_enabled; active=$legacy_active ;;
      command-space-dev.service) enabled=$legacy_dev_enabled; active=$legacy_dev_active ;;
    esac
    if [[ "$enabled" == true ]]; then
      systemctl --user enable "$unit" >/dev/null 2>&1 || true
    else
      systemctl --user disable "$unit" >/dev/null 2>&1 || true
    fi
    if [[ "$active" == true ]]; then
      systemctl --user restart "$unit" || printf 'Could not restart %s.\n' "$unit" >&2
    fi
  done
  if [[ "$dev_active" == true ]]; then
    systemctl --user restart super-space-dev.service || true
  fi
}

finish_install() {
  status=$?
  trap - EXIT INT TERM
  if (( status != 0 )); then
    if [[ "$transaction_ready" == true ]]; then
      printf 'Installation failed. Restoring the previous installation.\n' >&2
      systemctl --user stop super-space.service >/dev/null 2>&1 || true
      if ! installation_state restore; then
        printf 'Recovery files remain at %s. Restore failed; do not delete this directory.\n' "$transaction" >&2
        exit "$status"
      fi
    fi
    if [[ "$services_stopped" == true ]]; then
      restore_services
    fi
    if [[ "$transaction_ready" == true ]]; then
      if systemctl --user show-environment | python3 -c 'import sys; sys.exit(not any(line.startswith("HYPRLAND_INSTANCE_SIGNATURE=") for line in sys.stdin))'; then
        systemd-run --user --quiet --wait --pipe --collect hyprctl reload config-only >/dev/null 2>&1 || true
        systemd-run --user --quiet --wait --pipe --collect /usr/share/omarchy/bin/omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
      fi
      update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$transaction"
  exit "$status"
}
trap finish_install EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
services_stopped=true
if [[ "$legacy_active" == true ]]; then
  systemctl --user stop command-space.service
fi
if [[ "$legacy_dev_active" == true ]]; then
  systemctl --user stop command-space-dev.service
fi
if [[ "$service_active" == true ]]; then
  systemctl --user stop super-space.service
fi
if [[ "$dev_active" == true ]]; then
  systemctl --user stop super-space-dev.service
fi
installation_state save
transaction_ready=true
python3 scripts/migrate-legacy.py migrate
mkdir -p "$install_root/bin" "$install_root/runtime" "$HOME/.local/bin" "$HOME/.config/systemd/user" "$HOME/.local/share/applications"
install -m 755 "$binary" "$install_root/bin/super-space.new"
mv "$install_root/bin/super-space.new" "$install_root/bin/super-space"
rsync -a --delete --exclude node_modules --exclude tests runtime/ "$install_root/runtime/"
if [[ "$profile" == --prebuilt ]]; then
  rsync -a --delete runtime/node_modules/ "$install_root/runtime/node_modules/"
else
  bun install --cwd "$install_root/runtime" --production --frozen-lockfile --ignore-scripts
fi
ln -sfn "$install_root/bin/super-space" "$HOME/.local/bin/super-space"
install -m 755 scripts/start-daemon.sh "$install_root/bin/start-daemon"
cat > "$HOME/.local/bin/super-space-menu" <<'SH'
#!/bin/sh
exec "$HOME/.local/bin/super-space" "${@:-toggle}"
SH
chmod +x "$HOME/.local/bin/super-space-menu"
cat > "$HOME/.config/systemd/user/super-space.service" <<'SERVICE'
[Unit]
Description=Super Space launcher
After=graphical-session-pre.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=%h/.local/share/super-space/bin/start-daemon
Environment=PATH=%h/.bun/bin:%h/.local/bin:%h/.local/share/mise/shims:%h/.cargo/bin:/usr/share/omarchy/bin:/usr/local/bin:/usr/bin
Restart=on-failure
RestartSec=2

[Install]
WantedBy=graphical-session.target
SERVICE
cat > "$HOME/.local/share/applications/super-space.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Super Space
Comment=Search applications, Omarchy commands, and extensions
Exec=$HOME/.local/bin/super-space %u
Icon=system-search
Terminal=false
NoDisplay=true
Categories=Utility;
MimeType=x-scheme-handler/super-space;x-scheme-handler/command-space;x-scheme-handler/rustcast;x-scheme-handler/raycast;x-scheme-handler/com.raycast;
StartupWMClass=super-space
DESKTOP
systemctl --user daemon-reload
"$HOME/.local/bin/super-space" integration apply
mkdir -p "$install_root/bundled-extensions"
rsync -a --delete --exclude node_modules --exclude .git extensions/ "$install_root/bundled-extensions/"
for bundled in "$install_root/bundled-extensions"/*; do
  [[ -f "$bundled/package.json" ]] || continue
  "$HOME/.local/bin/super-space" extension install "$bundled" --replace
done
systemctl --user stop super-space-dev.service 2>/dev/null || true
systemctl --user restart super-space.service
ready=false
for attempt in {1..300}; do
  if "$HOME/.local/bin/super-space" ping >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.1
done
if [[ $ready != true ]]; then
  systemctl --user status super-space.service --no-pager
  exit 1
fi
systemctl --user disable command-space.service command-space-dev.service 2>/dev/null || true
python3 scripts/migrate-legacy.py cleanup
systemctl --user daemon-reload
update-desktop-database "$HOME/.local/share/applications"
exec 8>&-
python3 scripts/migrate-legacy.py clear-cache
printf 'Super Space is installed. Use Super+Space to open it.\n'
