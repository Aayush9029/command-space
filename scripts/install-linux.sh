#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$project_dir"
profile=${1:---release}
if [[ "$profile" == --prebuilt ]]; then
  binary=bin/command-space
elif [[ "$profile" == --debug ]]; then
  nice -n 10 cargo build --bin command-space
  binary=target/debug/command-space
else
  nice -n 10 cargo build --release --bin command-space
  binary=target/release/command-space
fi
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/command-space"
mkdir -p "$install_root/bin" "$install_root/runtime" "$HOME/.local/bin" "$HOME/.config/systemd/user" "$HOME/.local/share/applications"
install -m 755 "$binary" "$install_root/bin/command-space.new"
mv "$install_root/bin/command-space.new" "$install_root/bin/command-space"
rsync -a --delete --exclude node_modules --exclude tests runtime/ "$install_root/runtime/"
if [[ "$profile" == --prebuilt ]]; then
  rsync -a --delete runtime/node_modules/ "$install_root/runtime/node_modules/"
else
  npm ci --prefix "$install_root/runtime" --omit=dev --ignore-scripts --no-audit --no-fund
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
Environment=PATH=%h/.local/bin:%h/.local/share/mise/shims:%h/.cargo/bin:/usr/share/omarchy/bin:/usr/local/bin:/usr/bin
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
if [[ ! -d "$install_root/extensions/developer-tools" ]]; then
  "$HOME/.local/bin/command-space" extension install extensions/developer-tools
fi
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
